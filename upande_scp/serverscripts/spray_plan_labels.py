"""Spray Plan label PDF generator.

Builds a printable PDF for the Zebra ZQ520 (4" wide thermal stock).
For each selected Stock Entry, every attached image yields one label —
so an SE with 3 attachments produces 3 labels.

Each label shows the QR image (left) plus chemical-specific details
(right): chemical name, qty + uom, source/target warehouse, scheduled
application date. Item details come from the matching row in the SE's
items table, looked up by item_code parsed from the QR file name (the
naming convention is `QR_<SE_name>_<item_code>.<ext>`).

Page layout: 102mm × 152mm (4" × 6"), 1/2/3 labels per page.
"""

import base64
import json
import mimetypes
import os
import re
from typing import List

import frappe
from frappe.utils import escape_html, fmt_money
from frappe.utils.pdf import get_pdf

IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp")

# Matches `QR_<anything>_<item_code>.<ext>` — item_code is the trailing
# segment before the extension. Lenient to accommodate other naming.
_FILENAME_ITEM_RE = re.compile(r"_([^_]+)\.[^.]+$")


def _is_image(file_name: str) -> bool:
	return (file_name or "").lower().endswith(IMAGE_EXTS)


def _item_code_from_filename(file_name: str) -> str:
	"""Best-effort extract of the item code from a QR filename."""
	m = _FILENAME_ITEM_RE.search(file_name or "")
	return m.group(1) if m else ""


def _resolve_image_src(file_url: str, is_private: int) -> str:
	"""Read the file from disk and return a base64 data URI.

	Public file URLs (/files/foo.png) live at <site>/public/files/foo.png;
	private (/private/files/foo.png) at <site>/private/files/foo.png. Embedding
	bypasses wkhtmltopdf's local-file-access restrictions and keeps the PDF
	self-contained.
	"""
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
	"""Format `2026-05-07 09:30:00` → `07 May 2026 09:30`."""
	if not dt:
		return ""
	s = str(dt)
	try:
		return frappe.utils.format_datetime(s, "dd MMM yyyy HH:mm")
	except Exception:
		return s.split(".")[0]


def _collect_labels(se_names: List[str]):
	"""Yield one dict per (SE, image) pair, in selection order."""
	labels = []
	skipped = []

	# Pre-fetch scheduled dates for all referenced work orders.
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

		# item_code → first matching SE item row
		items_by_code = {}
		for it in (se.items or []):
			items_by_code.setdefault(it.item_code, it)

		wo = wo_sched.get(se.work_order) if se.work_order else None
		scheduled = _fmt_date(wo.custom_scheduled_application_time) if wo else ""
		spray_type = (wo.custom_spray_type if wo else "") or ""

		added = 0
		for img in images:
			src = _resolve_image_src(img.file_url, img.is_private)
			if not src:
				continue

			item_code = _item_code_from_filename(img.file_name)
			item = items_by_code.get(item_code)

			# Per-item warehouses fall back to SE-level if the row doesn't have them
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


def _render_label(lbl: dict) -> str:
	def row(label, value):
		if not value:
			return ""
		return (
			f'<tr><td class="k">{escape_html(label)}</td>'
			f'<td class="v">{escape_html(str(value))}</td></tr>'
		)

	return f"""
<div class="label">
  <div class="qr"><img src="{escape_html(lbl['image_src'])}" /></div>
  <div class="info">
    <div class="se">{escape_html(lbl['se_name'])}</div>
    <div class="chem">{escape_html(lbl['chem_name'] or '—')}</div>
    <table>
      {row('Qty', lbl['qty_str'])}
      {row('From', lbl['source'])}
      {row('To', lbl['target'])}
      {row('Scheduled', lbl['scheduled'])}
      {row('Type', lbl['spray_type'])}
    </table>
  </div>
</div>
"""


def _render_html(labels, per_page: int) -> str:
	per_page = max(1, min(3, per_page))
	label_h_mm = 152 / per_page

	# Tighten typography as the label gets shorter.
	if per_page == 1:
		base_pt, head_pt, kv_pt = 11, 14, 10
	elif per_page == 2:
		base_pt, head_pt, kv_pt = 8, 10, 8
	else:
		base_pt, head_pt, kv_pt = 7, 8.5, 6.8

	rows = "".join(_render_label(l) for l in labels)

	return f"""
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
@page {{ size: 102mm 152mm; margin: 0; }}
html, body {{ margin: 0; padding: 0; }}
body {{ font-family: Helvetica, Arial, sans-serif; color: #000; background: #fff; }}

.label {{
  width: 102mm;
  height: {label_h_mm:.2f}mm;
  padding: 2.5mm;
  box-sizing: border-box;
  border-bottom: 0.3mm dashed #000;
  page-break-inside: avoid;
  display: table;
  table-layout: fixed;
  font-size: {base_pt}pt;
}}
.label:nth-child({per_page}n) {{
  border-bottom: none;
  page-break-after: always;
}}
.label:last-child {{
  border-bottom: none;
  page-break-after: auto;
}}

.qr, .info {{ display: table-cell; vertical-align: middle; }}
.qr  {{ width: 45%; padding-right: 2.5mm; text-align: center; }}
.qr img {{ max-width: 100%; max-height: {label_h_mm - 6:.2f}mm; }}
.info {{ width: 55%; }}

.se   {{ font-weight: bold; font-size: {head_pt}pt; line-height: 1.1; }}
.chem {{ font-weight: bold; font-size: {head_pt - 1}pt; margin: 0.5mm 0 1mm; line-height: 1.15; }}

table {{ width: 100%; border-collapse: collapse; font-size: {kv_pt}pt; }}
td {{ padding: 0.4mm 0; vertical-align: top; line-height: 1.2; }}
td.k {{ width: 38%; color: #444; font-weight: 600; padding-right: 1mm; }}
td.v {{ word-break: break-word; }}
</style>
</head>
<body>
{rows}
</body>
</html>
"""


@frappe.whitelist()
def generate_pdf(se_names, per_page=2):
	"""Build a label PDF for the given stock entry names.

	Args:
	    se_names: JSON-encoded list (from JS) or list of Stock Entry names.
	    per_page: 1, 2, or 3.

	Returns:
	    {data: base64-pdf, filename: str, label_count: int, skipped: [...]}
	"""
	if isinstance(se_names, str):
		se_names = json.loads(se_names)
	if not isinstance(se_names, list) or not se_names:
		frappe.throw("se_names must be a non-empty list")

	per_page = int(per_page or 2)

	labels, skipped = _collect_labels(se_names)

	if not labels:
		return {
			"data": None,
			"filename": None,
			"label_count": 0,
			"skipped": skipped,
		}

	html = _render_html(labels, per_page)

	pdf_bytes = get_pdf(
		html,
		options={
			"page-width": "102mm",
			"page-height": "152mm",
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
