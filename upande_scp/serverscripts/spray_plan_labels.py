"""Spray Plan label PDF generator.

Operator picks any label W × H and either:
  - **thermal**  → PDF page == label size, one label per page (Zebra ZQ520 et al.)
  - **a4_tile**  → labels packed onto an A4 page with dashed cut-lines.

Layout adapts to the chosen size via the tier table in
``upande_scp/upande_scp/shared/label_tiers.json``. The QR is always the
hero element; non-essential fields drop out as the label shrinks, in a
deterministic priority order. Both the live preview in the React page
and this renderer read the same JSON so they stay in lockstep.

Legacy callers (the Stock Entry list-view client script) still pass
``per_page=1|2|3``. We translate that to the 102×152mm A4-tile geometry
the old renderer used so the output is byte-equivalent.

Each label still shows the QR (left or top) plus chemical-specific
details from the SE row. Item details come from the matching SE item
row, looked up by item_code parsed from the QR file name (the naming
convention is ``QR_<SE_name>_<item_code>.<ext>``).
"""

import base64
import json
import mimetypes
import os
import re
from functools import lru_cache
from typing import List

import frappe
from frappe.utils import escape_html
from frappe.utils.pdf import get_pdf

IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp")

# Matches `QR_<anything>_<item_code>.<ext>` — item_code is the trailing
# segment before the extension. Lenient to accommodate other naming.
_FILENAME_ITEM_RE = re.compile(r"_([^_]+)\.[^.]+$")

# Tiers where the simpler-QR preference kicks in. At larger tiers the
# full QR is fine (more error correction = more reliable scan).
_SIMPLE_QR_TIERS = ("xs", "s")
# Filename markers that flag an attachment as the "simpler" variant —
# typically a low-density QR generated with fewer modules / minimal
# payload, so it still scans when shrunk to a 20mm sticker.
_SIMPLE_QR_MARKERS = ("MIN", "SIMPLE", "SMALL", "MINI")

# A4 dimensions used by the tile mode.
_A4_W_MM = 210
_A4_H_MM = 297
_A4_MARGIN_MM = 5
_A4_GUTTER_MM = 2


# ────────────────────────────────────────────────────────────────────────
#  Tier table — shared with the TS live preview
# ────────────────────────────────────────────────────────────────────────


@lru_cache(maxsize=1)
def _load_tiers() -> dict:
	"""Load the canonical tier table once per process."""
	path = os.path.join(
		frappe.get_app_path("upande_scp"), "shared", "label_tiers.json"
	)
	with open(path, "r", encoding="utf-8") as f:
		return json.load(f)


def plan_label(width_mm: float, height_mm: float) -> dict:
	"""Pick the tier for a given label W × H.

	Returns a plan dict with the keys consumed by ``_render_label_html``.
	"""
	cfg = _load_tiers()
	min_dim = min(width_mm, height_mm)

	# Find the first tier whose ``min_dim_lt`` is greater than this label's
	# minimum dimension. A null ``min_dim_lt`` is the catch-all (xl).
	tier = None
	for t in cfg["tiers"]:
		lt = t.get("min_dim_lt")
		if lt is None or min_dim < lt:
			tier = t
			break
	# Defensive — shouldn't happen with the bundled JSON.
	if tier is None:
		tier = cfg["tiers"][-1]

	# Aspect-ratio guard: square-ish labels read better stacked.
	orientation = tier["orientation"]
	if (
		orientation == "row"
		and max(width_mm, height_mm) / max(min_dim, 0.0001)
		< cfg["stack_ratio_threshold"]
	):
		orientation = "stack"

	# QR side length in mm — never below the configured floor.
	qr_side = max(tier["qr_min_mm"], min_dim * tier["qr_pct"] / 100.0)

	# Stack orientation prefers dropping spatial fields first (from / to).
	fields = list(tier["fields"])
	if orientation == "stack":
		fields = [f for f in fields if f not in ("from", "to")]

	return {
		"tier": tier["tier"],
		"qr_side_mm": round(qr_side, 3),
		"fields": fields,
		"base_pt": tier["base_pt"],
		"head_pt": tier["head_pt"],
		"orientation": orientation,
	}


# ────────────────────────────────────────────────────────────────────────
#  Label data assembly (unchanged from the legacy renderer)
# ────────────────────────────────────────────────────────────────────────


def _is_image(file_name: str) -> bool:
	return (file_name or "").lower().endswith(IMAGE_EXTS)


def _item_code_from_filename(file_name: str) -> str:
	m = _FILENAME_ITEM_RE.search(file_name or "")
	return m.group(1) if m else ""


def _resolve_image_src(file_url: str, is_private: int) -> str:
	if not file_url:
		return ""
	if file_url.startswith("/private/files/"):
		rel = file_url[len("/private/files/"):]
		abs_path = os.path.abspath(os.path.join(frappe.get_site_path("private", "files"), rel))
	elif file_url.startswith("/files/"):
		rel = file_url[len("/files/"):]
		abs_path = os.path.abspath(os.path.join(frappe.get_site_path("public", "files"), rel))
	else:
		abs_path = os.path.abspath(frappe.get_site_path(file_url.lstrip("/")))
	if not os.path.exists(abs_path):
		return ""
	mime, _ = mimetypes.guess_type(abs_path)
	if not mime:
		mime = "image/jpeg"
	with open(abs_path, "rb") as f:
		b64 = base64.b64encode(f.read()).decode("ascii")
	return f"data:{mime};base64,{b64}"


def _fmt_qty(qty) -> str:
	if qty is None:
		return ""
	try:
		f = float(qty)
	except (TypeError, ValueError):
		return str(qty)
	if f.is_integer():
		return str(int(f))
	return f"{f:g}"


def _fmt_date(dt) -> str:
	if not dt:
		return ""
	s = str(dt)
	try:
		return frappe.utils.format_datetime(s, "dd MMM yyyy HH:mm")
	except Exception:
		return s.split(".")[0]


def _is_simple_qr(file_name: str) -> bool:
	"""Match attachments the operator marked as the lower-density variant.

	Naming convention: any image whose filename contains MIN/SIMPLE/
	SMALL/MINI (case-insensitive). The operator generates a second QR
	with fewer modules / a stripped payload and names it accordingly;
	we pick it up automatically at small label tiers.
	"""
	upper = (file_name or "").upper()
	return any(marker in upper for marker in _SIMPLE_QR_MARKERS)


def _pick_qr_for_item(images: list, item_code: str, prefer_simple: bool):
	"""Pick the right QR attachment for one chemical row.

	Order of preference (each falls through to the next if no match):
	  1. simple-QR for this exact item_code   (only when prefer_simple)
	  2. simple-QR for any item_code          (only when prefer_simple)
	  3. regular QR for this exact item_code
	  4. first image in the attachment list   (legacy single-QR SEs)
	"""
	def by_code(pool, code):
		for f in pool:
			if _item_code_from_filename(f["file_name"]) == code:
				return f
		return None

	simple_pool = [f for f in images if _is_simple_qr(f["file_name"])]
	regular_pool = [f for f in images if not _is_simple_qr(f["file_name"])]

	if prefer_simple and simple_pool:
		match = by_code(simple_pool, item_code) or simple_pool[0]
		return match

	match = by_code(regular_pool, item_code) or by_code(images, item_code)
	return match or images[0]


def _collect_labels(se_names: List[str], prefer_simple_qr: bool = False):
	"""Yield one dict per chemical line on each SE, in selection order.

	``prefer_simple_qr`` flips the QR-attachment picker into low-density
	mode — used when the planned label tier is XS / S so the QR still
	scans after being shrunk.
	"""
	labels = []
	skipped = []

	wo_names = set()
	se_docs = {}
	for se_name in se_names:
		try:
			se = frappe.get_doc("Stock Entry", se_name)
		except frappe.DoesNotExistError:
			continue
		se_docs[se_name] = se
		if se.work_order:
			wo_names.add(se.work_order)

	wo_sched = {}
	if wo_names:
		for row in frappe.get_all(
			"Work Order",
			filters={"name": ("in", list(wo_names))},
			fields=["name", "custom_scheduled_application_time", "custom_spray_type"],
		):
			wo_sched[row.name] = row

	for se_name in se_names:
		se = se_docs.get(se_name)
		if not se:
			skipped.append({"se": se_name, "reason": "not found"})
			continue

		files = frappe.get_all(
			"File",
			filters={
				"attached_to_doctype": "Stock Entry",
				"attached_to_name": se_name,
			},
			fields=["file_url", "file_name", "is_private"],
			order_by="creation asc",
		)
		images = [f for f in files if _is_image(f.file_name)]

		if not images:
			skipped.append({"se": se_name, "reason": "no image attachments"})
			continue

		items_by_code = {}
		for it in (se.items or []):
			items_by_code.setdefault(it.item_code, it)

		wo = wo_sched.get(se.work_order) if se.work_order else None
		scheduled = _fmt_date(wo.custom_scheduled_application_time) if wo else ""
		spray_type = (wo.custom_spray_type if wo else "") or ""

		# One label per chemical row, not one per image — the previous
		# loop walked images and looked up the item, which dropped any
		# row that didn't have a matching image. Iterating by item lets
		# us choose the right QR (simple vs regular) per row instead.
		added = 0
		for item_code, item in items_by_code.items():
			img = _pick_qr_for_item(images, item_code, prefer_simple_qr)
			if not img:
				continue
			src = _resolve_image_src(img["file_url"], img["is_private"])
			if not src:
				continue

			if item:
				chem_name = item.item_name or item.item_code or ""
				qty_str = f"{_fmt_qty(item.qty)} {item.stock_uom or ''}".strip()
				src_wh = item.s_warehouse or se.from_warehouse or ""
				tgt_wh = item.t_warehouse or se.to_warehouse or ""
			else:
				chem_name = ""
				qty_str = ""
				src_wh = se.from_warehouse or ""
				tgt_wh = se.to_warehouse or ""

			labels.append(
				{
					"se_name": se_name,
					"image_src": src,
					"chem_name": chem_name,
					"item_code": item_code,
					"qty_str": qty_str,
					"source": src_wh,
					"target": tgt_wh,
					"scheduled": scheduled,
					"spray_type": spray_type,
				}
			)
			added += 1

		if not added:
			skipped.append({"se": se_name, "reason": "image files missing on disk"})

	return labels, skipped


# ────────────────────────────────────────────────────────────────────────
#  Per-label HTML rendering (tier-driven)
# ────────────────────────────────────────────────────────────────────────


def _field_row(field: str, lbl: dict) -> str:
	"""Render one (key, value) pair for the info panel.

	Returns the empty string if the value is empty — the renderer just
	skips it, so blank fields don't take up space.
	"""
	def row(label, value):
		if not value:
			return ""
		return (
			f'<tr><td class="k">{escape_html(label)}</td>'
			f'<td class="v">{escape_html(str(value))}</td></tr>'
		)

	if field == "chem":
		# Chem name renders as a heading, not as a kv row.
		return ""
	if field == "qty":
		return row("Qty", lbl["qty_str"])
	if field == "se":
		return ""  # SE name renders as a heading.
	if field == "from":
		return row("From", lbl["source"])
	if field == "to":
		return row("To", lbl["target"])
	if field == "sched":
		return row("Scheduled", lbl["scheduled"])
	if field == "type":
		return row("Type", lbl["spray_type"])
	return ""


def _render_label_html(lbl: dict, plan: dict) -> str:
	"""Render one label's inner HTML — QR + (optional) info block."""
	tier = plan["tier"]
	fields = plan["fields"]
	is_xs = tier == "xs"

	if is_xs or not fields:
		# QR-only — image fills the label, no text.
		return (
			f'<div class="label label-xs">'
			f'<img class="qr-fill" src="{escape_html(lbl["image_src"])}" />'
			f'</div>'
		)

	# Heading block — SE name shown only if "se" is in fields.
	heading_parts = []
	if "se" in fields and lbl["se_name"]:
		heading_parts.append(
			f'<div class="se">{escape_html(lbl["se_name"])}</div>'
		)
	if "chem" in fields and lbl["chem_name"]:
		heading_parts.append(
			f'<div class="chem">{escape_html(lbl["chem_name"])}</div>'
		)
	heading = "".join(heading_parts) or "<div class=\"chem\">—</div>"

	rows_html = "".join(_field_row(f, lbl) for f in fields)
	table_html = (
		f'<table class="kv">{rows_html}</table>' if rows_html else ""
	)

	return (
		f'<div class="label label-{plan["orientation"]}">'
		f'<div class="qr">'
		f'<img src="{escape_html(lbl["image_src"])}" />'
		f'</div>'
		f'<div class="info">{heading}{table_html}</div>'
		f'</div>'
	)


# ────────────────────────────────────────────────────────────────────────
#  Page renderers — thermal vs A4 tile
# ────────────────────────────────────────────────────────────────────────


def _css_common(width_mm: float, height_mm: float, plan: dict) -> str:
	"""CSS shared by both page modes, parameterised by label size + plan.

	Loads Poppins from Google Fonts so the PDF matches the live preview
	(which gets Poppins from the SPA's index.css). wkhtmltopdf fetches
	the font at render time — if the host has no outbound HTTPS the
	browser-stack default (sans-serif) is used and the PDF still renders.
	"""
	orientation = plan["orientation"]
	qr_side = plan["qr_side_mm"]
	base_pt = plan["base_pt"]
	head_pt = plan["head_pt"]
	# The qr-fill class (xs tier) makes the QR fill the label; the
	# non-xs tiers use ``qr_side`` to constrain the QR image.
	if orientation == "row":
		qr_layout = (
			f".label-row {{ display: flex; flex-direction: row; align-items: center; }}\n"
			f".label-row .qr {{ flex: 0 0 {qr_side:.2f}mm; padding-right: 1.5mm; }}\n"
			f".label-row .info {{ flex: 1 1 auto; min-width: 0; }}\n"
		)
	else:
		qr_layout = (
			f".label-stack {{ display: flex; flex-direction: column; align-items: center; }}\n"
			f".label-stack .qr {{ flex: 0 0 auto; padding-bottom: 0.8mm; }}\n"
			f".label-stack .info {{ flex: 1 1 auto; text-align: center; min-width: 0; }}\n"
		)

	return f"""
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');
html, body {{ margin: 0; padding: 0; }}
body {{ font-family: 'Poppins', Helvetica, Arial, sans-serif; color: #000; background: #fff; }}
.label {{
  width: {width_mm:.2f}mm;
  height: {height_mm:.2f}mm;
  padding: 1.2mm;
  box-sizing: border-box;
  font-size: {base_pt}pt;
  overflow: hidden;
}}
.label-xs {{
  display: flex; align-items: center; justify-content: center;
  padding: 0.5mm;
}}
.label-xs .qr-fill {{
  max-width: 100%; max-height: 100%;
}}
.qr {{ text-align: center; }}
.qr img {{
  width: {qr_side:.2f}mm;
  height: {qr_side:.2f}mm;
  display: block;
  margin: 0 auto;
}}
.info .se {{ font-weight: bold; font-size: {head_pt}pt; line-height: 1.1; }}
.info .chem {{ font-weight: bold; font-size: {max(head_pt - 1, 6)}pt; margin: 0.5mm 0 1mm; line-height: 1.15; }}
table.kv {{ width: 100%; border-collapse: collapse; font-size: {base_pt}pt; }}
table.kv td {{ padding: 0.3mm 0; vertical-align: top; line-height: 1.2; }}
table.kv td.k {{ width: 38%; color: #444; font-weight: 600; padding-right: 1mm; }}
table.kv td.v {{ word-break: break-word; }}
{qr_layout}
"""


def _render_thermal_html(
	labels: list, width_mm: float, height_mm: float, plan: dict
) -> str:
	"""One label per page; page size == label size."""
	rows = "".join(_render_label_html(l, plan) for l in labels)
	common = _css_common(width_mm, height_mm, plan)
	return f"""
<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
@page {{ size: {width_mm:.2f}mm {height_mm:.2f}mm; margin: 0; }}
{common}
.label {{ page-break-after: always; }}
.label:last-child {{ page-break-after: auto; }}
</style></head><body>{rows}</body></html>
"""


def _render_a4_html(
	labels: list,
	width_mm: float,
	height_mm: float,
	plan: dict,
	sheet_w_mm: float = _A4_W_MM,
	sheet_h_mm: float = _A4_H_MM,
) -> str:
	"""Tile labels onto an A4 (or rotated A4) page with dashed cut-lines.

	Layout uses CSS grid sized to the label W × H so the browser does the
	column-count math. Cut-lines are drawn as label borders, kept dashed
	to make it obvious where to cut. ``sheet_w_mm``/``sheet_h_mm`` swap
	for landscape orientation.
	"""
	common = _css_common(width_mm, height_mm, plan)

	usable_w = sheet_w_mm - 2 * _A4_MARGIN_MM
	usable_h = sheet_h_mm - 2 * _A4_MARGIN_MM
	cols = max(1, int(usable_w // width_mm))
	rows_per_page = max(1, int(usable_h // height_mm))
	per_page = cols * rows_per_page

	# Chunk labels into pages so we can stamp page-break-after correctly.
	pages = []
	for i in range(0, len(labels), per_page):
		page_labels = labels[i:i + per_page]
		rows = "".join(_render_label_html(l, plan) for l in page_labels)
		pages.append(f'<div class="sheet">{rows}</div>')
	sheets = "".join(pages)

	return f"""
<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
@page {{ size: {sheet_w_mm}mm {sheet_h_mm}mm; margin: {_A4_MARGIN_MM}mm; }}
{common}
.sheet {{
  display: grid;
  grid-template-columns: repeat({cols}, {width_mm:.2f}mm);
  grid-auto-rows: {height_mm:.2f}mm;
  gap: {_A4_GUTTER_MM}mm;
  page-break-after: always;
}}
.sheet:last-child {{ page-break-after: auto; }}
.label {{ border: 0.2mm dashed #888; }}
</style></head><body>{sheets}</body></html>
"""


# ────────────────────────────────────────────────────────────────────────
#  Public API
# ────────────────────────────────────────────────────────────────────────


def _legacy_per_page_to_geometry(per_page: int) -> tuple[float, float, str]:
	"""Translate the legacy ``per_page`` knob to the new geometry.

	Old behaviour: page size 102×152mm, ``per_page`` labels stacked
	vertically on that page, dashed cut-line between them. The closest
	new-engine geometry is each label sized 102 × (152/per_page) mm,
	output as ``a4_tile`` BUT on a 102×152mm sheet — which we model by
	setting the sheet to A4 wouldn't match. Instead we explicitly render
	in the legacy 102×152 sheet for backward compatibility.
	"""
	per_page = max(1, min(3, int(per_page)))
	return 102.0, 152.0 / per_page, "legacy_102x152"


def _render_legacy_html(
	labels: list, width_mm: float, height_mm: float, plan: dict
) -> str:
	"""Byte-stable legacy 102x152mm page with N labels stacked.

	Reproduces the pre-refactor renderer's HTML shape (no CSS grid,
	dashed bottom border, page-break after every Nth label) so existing
	callers passing ``per_page=1|2|3`` get the same output.
	"""
	per_page = max(1, int(round(152.0 / height_mm)))
	rows = "".join(_render_label_html(l, plan) for l in labels)
	common = _css_common(width_mm, height_mm, plan)
	return f"""
<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
@page {{ size: 102mm 152mm; margin: 0; }}
{common}
.label {{ border-bottom: 0.3mm dashed #000; page-break-inside: avoid; }}
.label:nth-child({per_page}n) {{ border-bottom: none; page-break-after: always; }}
.label:last-child {{ border-bottom: none; page-break-after: auto; }}
</style></head><body>{rows}</body></html>
"""


@frappe.whitelist()
def generate_pdf(
	se_names,
	width_mm: float | int | str | None = None,
	height_mm: float | int | str | None = None,
	output_mode: str = "thermal",
	orientation: str = "portrait",
	font_scale: float | int | str = 1.0,
	per_page=None,
):
	"""Build a label PDF for the given Stock Entry names.

	Args:
	    se_names: JSON-encoded list or list of Stock Entry names.
	    width_mm: label width in mm (15–500).
	    height_mm: label height in mm (15–500).
	    output_mode: ``thermal`` (one label per page) or ``a4_tile``
	        (pack on A4 with cut-lines).
	    orientation: ``portrait`` (default — page = W×H as entered) or
	        ``landscape`` (page = H×W, useful when the operator wants
	        to flip a label without re-entering dimensions). For
	        ``a4_tile`` mode the A4 sheet rotates with this flag too.
	    font_scale: multiplier applied to the tier's base/head font
	        sizes. 1.0 = normal, <1 shrinks, >1 grows. Clamped to
	        [0.5, 1.6] server-side.
	    per_page: LEGACY. 1, 2 or 3 — reproduces the old 102×152mm
	        page with N labels stacked. Mutually exclusive with the
	        width/height/output_mode params; if both are passed the
	        legacy mode wins.

	Returns:
	    {data: base64-pdf, filename: str, label_count: int, skipped: [...]}
	"""
	if isinstance(se_names, str):
		se_names = json.loads(se_names)
	if not isinstance(se_names, list) or not se_names:
		frappe.throw("se_names must be a non-empty list")

	cfg = _load_tiers()
	floor = float(cfg["min_dim_floor_mm"])

	# Decide which renderer to call up-front so validation messages are
	# specific to the mode the caller actually used.
	if per_page is not None:
		width_mm, height_mm, output_mode = _legacy_per_page_to_geometry(per_page)
		orientation = "portrait"  # legacy renderer ignores orientation
	else:
		width_mm = float(width_mm) if width_mm is not None else 102.0
		height_mm = float(height_mm) if height_mm is not None else 152.0
		output_mode = (output_mode or "thermal").lower()
		orientation = (orientation or "portrait").lower()
		if output_mode not in ("thermal", "a4_tile"):
			frappe.throw("output_mode must be 'thermal' or 'a4_tile'")
		if orientation not in ("portrait", "landscape"):
			frappe.throw("orientation must be 'portrait' or 'landscape'")
		if width_mm < floor or height_mm < floor:
			frappe.throw(
				f"Label too small — width and height must each be at "
				f"least {floor:g}mm (got {width_mm:g} × {height_mm:g}).",
				title="Label size out of range",
			)
		if width_mm > 500 or height_mm > 500:
			frappe.throw(
				"Label too large — width and height must each be at most 500mm.",
				title="Label size out of range",
			)

	# Orientation determines which of the two dims is the page's width
	# vs height. The user enters dimensions in either order; we
	# normalise here so landscape ALWAYS produces a wide page (and
	# therefore a row layout — QR on the left, info on the right) and
	# portrait always produces a tall page.
	long_dim = max(width_mm, height_mm)
	short_dim = min(width_mm, height_mm)
	if orientation == "landscape":
		width_mm, height_mm = long_dim, short_dim
	else:  # portrait
		width_mm, height_mm = short_dim, long_dim

	try:
		font_scale_f = float(font_scale)
	except (TypeError, ValueError):
		font_scale_f = 1.0
	# Clamp — too far down and text becomes unreadable; too far up
	# and it spills out of the label.
	font_scale_f = max(0.5, min(1.6, font_scale_f))

	plan = plan_label(width_mm, height_mm)
	plan["base_pt"] = round(plan["base_pt"] * font_scale_f, 2)
	plan["head_pt"] = round(plan["head_pt"] * font_scale_f, 2)
	# At the smaller tiers we prefer a low-density QR when one was
	# generated alongside the regular one (see ``_pick_qr_for_item``).
	prefer_simple = plan["tier"] in _SIMPLE_QR_TIERS
	labels, skipped = _collect_labels(se_names, prefer_simple_qr=prefer_simple)

	if not labels:
		return {
			"data": None,
			"filename": None,
			"label_count": 0,
			"skipped": skipped,
		}

	# A4-tile also rotates its sheet when the operator picked landscape.
	a4_w, a4_h = (_A4_H_MM, _A4_W_MM) if orientation == "landscape" else (_A4_W_MM, _A4_H_MM)

	if output_mode == "legacy_102x152":
		html = _render_legacy_html(labels, width_mm, height_mm, plan)
		page_w, page_h = 102, 152
	elif output_mode == "a4_tile":
		html = _render_a4_html(labels, width_mm, height_mm, plan, a4_w, a4_h)
		page_w, page_h = a4_w, a4_h
	else:  # thermal
		html = _render_thermal_html(labels, width_mm, height_mm, plan)
		page_w, page_h = width_mm, height_mm

	pdf_bytes = get_pdf(
		html,
		options={
			"page-width": f"{page_w}mm",
			"page-height": f"{page_h}mm",
			"margin-top": "0mm",
			"margin-bottom": "0mm",
			"margin-left": "0mm",
			"margin-right": "0mm",
			"disable-smart-shrinking": "",
			"enable-local-file-access": "",
		},
	)

	today = frappe.utils.nowdate()
	filename = f"spray_labels_{today}.pdf"

	return {
		"data": base64.b64encode(pdf_bytes).decode("ascii"),
		"filename": filename,
		"label_count": len(labels),
		"skipped": skipped,
	}
