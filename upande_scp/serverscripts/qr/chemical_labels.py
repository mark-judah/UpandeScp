"""Issuing and verifying traceable chemical label codes.

The codec is in ``chemical_code`` (pure). This module is the part that touches the
site: allocating each item's surrogate id, issuing a code per transferred line once
the Stock Entry is **submitted**, and verifying a scanned code.

Why issuing happens on submit rather than at approval: the approved Material Transfer
is what physically moved — nothing more, nothing less — so the quantity in the code is
a settled fact. Generating at draft time (which is what
``spray_plan_approval.approve_and_forward`` used to do) put a *proposed* quantity on
the sticker, and the draft stays editable until the storesman submits it.
"""
from __future__ import annotations

import frappe
from frappe.utils import flt, now_datetime

from upande_scp.serverscripts.common.crop_protection import is_foliar_group
from upande_scp.serverscripts.qr.chemical_code import (
	CodeError,
	decode,
	encode,
	looks_like_code,
	name_year,
	numeric_tail,
)
from upande_scp.serverscripts.qr.qr_generator import (
	attach_qr_to_document,
	generate_qr_base64,
	safe_filename,
)

LABEL = "Chemical QR Label"
TRANSFER_PURPOSE = "Material Transfer for Manufacture"

#: Error-correction level for the label image. **M (15% recovery), not L (7%).**
#: A chemical-store label is smudged and scuffed long before it is out-resolved: at
#: the smallest tier (18 mm) a v1 symbol still prints 6.9 dots per module on a 203 dpi
#: ZQ520, so the recovery level is what decides whether a worn label still scans.
#: The 33-digit code fits v1 at this level; 35 digits would not.
QR_ERROR_CORRECTION = "M"

#: Where the shared surrogate counter lives. One counter across both sidecar types so
#: a Chemical and a Foliar can never be handed the same id.
_SURROGATE_KEY = "scp_qr_item_id"


# ─────────────────────────── the item surrogate ──────────────────────────────


def _sidecar_for(item_code: str) -> tuple[str, str] | tuple[None, None]:
	"""``(doctype, name)`` of the item's SCP sidecar, creating nothing."""
	group = frappe.db.get_value("Item", item_code, "item_group")
	doctype = "Foliar" if is_foliar_group(group) else "Chemical"
	if frappe.db.exists(doctype, item_code):
		return doctype, item_code
	# The other kind, in case the item's group moved after the sidecar was made.
	other = "Chemical" if doctype == "Foliar" else "Foliar"
	if frappe.db.exists(other, item_code):
		return other, item_code
	return None, None


def item_surrogate(item_code: str) -> int:
	"""The item's stable numeric id for label codes, allocating one if needed.

	Not the item code itself: 15 of 695 chemical items on kaitet have non-numeric
	codes (``Foliar 1000``, ``Good Pest``), and nothing stops more being created.

	Returns 0 when the item has no sidecar and one cannot be made — the code is still
	issued, because a missing surrogate is a data gap and not a reason to leave a
	transfer unlabelled. The stored row still names the item exactly.
	"""
	doctype, name = _sidecar_for(item_code)
	if not doctype:
		return 0

	existing = frappe.db.get_value(doctype, name, "qr_item_id")
	if existing:
		return int(existing)

	# Allocate from the shared counter. `set_value` on a single field avoids running
	# the sidecar's full validation, which would fail on unrelated dirty links.
	next_id = _next_surrogate()
	frappe.db.set_value(doctype, name, "qr_item_id", next_id, update_modified=False)
	return next_id


def _next_surrogate() -> int:
	"""Next id from the shared counter, seeded past anything already allocated.

	Seeding from the live maximum rather than trusting the counter alone means a
	restored database, or a counter reset, cannot hand out an id that is already in
	use — and ids are never reused, so a reprinted label always means the same item.
	"""
	current = frappe.db.sql(
		"""SELECT GREATEST(
		       COALESCE((SELECT MAX(qr_item_id) FROM `tabChemical`), 0),
		       COALESCE((SELECT MAX(qr_item_id) FROM `tabFoliar`), 0)
		   ) AS m"""
	)
	highest = int((current[0][0] if current and current[0] else 0) or 0)

	# Raw SQL against tabSeries: it has no `creation` column, and get_value adds an
	# implicit ORDER BY that fails on it.
	row = frappe.db.sql(
		"SELECT current FROM tabSeries WHERE name = %s", (_SURROGATE_KEY,)
	)
	series = int((row[0][0] if row and row[0] else 0) or 0)
	nxt = max(highest, series) + 1
	if row:
		frappe.db.sql(
			"UPDATE tabSeries SET current = %s WHERE name = %s", (nxt, _SURROGATE_KEY)
		)
	else:
		frappe.db.sql(
			"INSERT INTO tabSeries (name, current) VALUES (%s, %s)",
			(_SURROGATE_KEY, nxt),
		)
	return nxt


# ─────────────────────────────── issuing ─────────────────────────────────────


def issue_for_stock_entry(doc, regenerate: bool = False) -> list[dict]:
	"""Issue one code per chemical line on a submitted transfer, and attach its QR.

	Idempotent: a line that already has a label keeps it, so a resubmit or a rerun of
	the backfill never mints a second code for the same physical sticker. Pass
	``regenerate=True`` only to reissue deliberately.
	"""
	if doc.purpose != TRANSFER_PURPOSE or doc.docstatus != 1:
		return []

	year = name_year(doc.name) or int(str(doc.posting_date or "")[:4] or 0) % 100
	se_tail = numeric_tail(doc.name)
	wo_tail = numeric_tail(doc.work_order)
	issued: list[dict] = []

	for row in doc.items or []:
		if not row.item_code:
			continue
		existing = frappe.db.get_value(
			LABEL,
			{"stock_entry": doc.name, "se_line_idx": row.idx},
			["name", "code"],
			as_dict=True,
		)
		if existing and not regenerate:
			issued.append({"code": existing.code, "item_code": row.item_code,
			               "reissued": False})
			continue

		surrogate = item_surrogate(row.item_code)
		try:
			code = encode(
				year=year,
				se_tail=se_tail,
				item_id=surrogate,
				qty=flt(row.qty),
				wo_tail=wo_tail,
			)
		except CodeError:
			# A segment overflowed — the label is skipped rather than issued wrong,
			# and the failure is recorded where somebody will see it.
			frappe.log_error(
				f"{doc.name} line {row.idx}: cannot encode a label code "
				f"(se_tail={se_tail} wo_tail={wo_tail} item={surrogate})",
				"Chemical QR – encode failed",
			)
			continue

		label = frappe.get_doc({
			"doctype": LABEL,
			"code": code,
			"stock_entry": doc.name,
			"se_line_idx": row.idx,
			"work_order": doc.work_order,
			"item_code": row.item_code,
			"item_name": row.item_name or row.item_code,
			"item_surrogate": surrogate,
			"qty": flt(row.qty),
			"uom": row.uom or row.stock_uom,
			"greenhouse": _greenhouse_of(doc),
			"farm": frappe.db.get_value("Warehouse", row.s_warehouse, "custom_farm"),
			"issued_at": now_datetime(),
		})
		label.flags.ignore_permissions = True
		label.insert(ignore_permissions=True)

		png = generate_qr_base64(code, error_correction=QR_ERROR_CORRECTION)
		if png:
			fname = f"QR_{doc.name}_{safe_filename(row.item_code)}.png"
			file_name = attach_qr_to_document("Stock Entry", doc.name, fname, png)
			if file_name:
				frappe.db.set_value(
					LABEL, label.name, "attachment", fname, update_modified=False
				)
		issued.append({"code": code, "item_code": row.item_code, "reissued": True})

	return issued


def _greenhouse_of(doc) -> str:
	if not doc.work_order:
		return ""
	return frappe.db.get_value("Work Order", doc.work_order, "custom_greenhouse") or ""


# ────────────────────────────── verifying ────────────────────────────────────


class ScanRefused(Exception):
	"""A scan that could not be verified. Carries the reason for the operator."""


def verify_scan(payload: str | None, work_order: str, item_code: str) -> dict:
	"""Check a scanned payload against the plan it is being used for.

	Returns ``{"verified": bool, "code": str|None, "why": str}``. Raises
	``ScanRefused`` when the payload IS one of our codes but fails a check — an
	unverifiable claim must not be recorded as a verified one.

	A legacy text payload (``"Score 250 EC\\n10 L"``) is not a code and cannot be
	checked at all, so it comes back ``verified=False`` and is allowed through: those
	stickers are already in circulation, and refusing them would stop work on the day
	this ships. The scan row records which it was, so the audit trail never claims a
	legacy scan proved something.
	"""
	if not looks_like_code(payload):
		return {
			"verified": False,
			"code": None,
			"why": "no traceable code on this label — reprint to get one",
		}

	code = str(payload).strip()
	try:
		parsed = decode(code)
	except CodeError as e:
		raise ScanRefused(str(e)) from e

	label = frappe.db.get_value(
		LABEL,
		code,
		["name", "stock_entry", "work_order", "item_code", "qty", "se_line_idx"],
		as_dict=True,
	)
	if not label:
		# The structured part of a code is guessable; the random tail is not, and it
		# has to match a row that was actually issued.
		raise ScanRefused(
			f"this code was never issued ({parsed.describe()})"
		)

	docstatus = frappe.db.get_value("Stock Entry", label.stock_entry, "docstatus")
	if docstatus != 1:
		state = "cancelled" if docstatus == 2 else "not submitted"
		raise ScanRefused(
			f"the transfer this label came from is {state} ({label.stock_entry}). "
			"The chemicals it describes were never issued — get a current label."
		)

	if label.work_order and work_order and label.work_order != work_order:
		raise ScanRefused(
			f"this label belongs to {label.work_order}, not {work_order}"
		)

	if item_code and label.item_code != item_code:
		raise ScanRefused(
			f"this label is for {label.item_code}, not {item_code}"
		)

	return {
		"verified": True,
		"code": code,
		"why": "",
		"stock_entry": label.stock_entry,
		"qty": flt(label.qty),
	}


# ────────────────────────────── read API ─────────────────────────────────────


@frappe.whitelist()
def labels_for_work_order(work_order: str) -> list[dict]:
	"""Every issued code for a plan.

	Whitelisted for the offline case: a device that downloads the day's schedule can
	take the codes with it and verify a scan with no network, then let the server
	re-check on sync. That is why the code needs no secret key — there would be
	nowhere safe to keep one on a handset.
	"""
	if not work_order:
		return []
	return frappe.get_all(
		LABEL,
		filters={"work_order": work_order},
		fields=[
			"code", "stock_entry", "se_line_idx", "item_code", "item_name",
			"qty", "uom", "greenhouse",
		],
		order_by="se_line_idx asc",
	)


@frappe.whitelist()
def explain_code(payload: str) -> dict:
	"""Take a code apart for a human, without judging it.

	For the storesman holding a label they cannot place. Reports the segments and
	whether the code was ever issued; does not require a work order.
	"""
	if not looks_like_code(payload):
		return {"valid": False, "why": "not a traceable label code"}
	code = str(payload).strip()
	try:
		parsed = decode(code)
	except CodeError as e:
		return {"valid": False, "why": str(e)}

	row = frappe.db.get_value(
		LABEL, code,
		["stock_entry", "work_order", "item_code", "item_name", "qty", "uom",
		 "greenhouse", "farm", "issued_at"],
		as_dict=True,
	)
	out = {
		"valid": True,
		"segments": {
			"format_version": parsed.version,
			"year": 2000 + parsed.year,
			"stock_entry_tail": parsed.se_tail,
			"item_surrogate": parsed.item_id,
			"qty": None if parsed.qty_overflowed else parsed.qty,
			"work_order_tail": parsed.wo_tail,
		},
		"readable": parsed.describe(),
		"issued": bool(row),
	}
	if row:
		out["label"] = row
		out["docstatus"] = frappe.db.get_value(
			"Stock Entry", row["stock_entry"], "docstatus"
		)
	return out


@frappe.whitelist()
def backfill(limit: int = 500, dry_run: int = 0) -> dict:
	"""Issue codes for submitted transfers that predate traceable labels.

	Restricted to the GM: issuing a code is minting the thing a scan is checked
	against, so it is not a store-floor action.

	Only touches **submitted** entries. A draft has not moved anything, and a
	cancelled one describes chemicals that were never issued — a code for either would
	be a label that should never verify.
	"""
	from upande_scp.serverscripts.spray_plan_creator.loaning import ELEVATED

	if not (set(frappe.get_roles(frappe.session.user)) & ELEVATED):
		frappe.throw(
			"Only the SCP General Manager can issue label codes.",
			frappe.PermissionError,
		)

	already = set(
		frappe.get_all(LABEL, pluck="stock_entry", limit_page_length=0)
	)
	candidates = frappe.get_all(
		"Stock Entry",
		filters={"purpose": TRANSFER_PURPOSE, "docstatus": 1},
		pluck="name",
		order_by="creation desc",
		limit_page_length=int(limit or 500),
	)
	pending = [n for n in candidates if n not in already]

	if int(dry_run or 0):
		return {"would_issue": pending, "already_labelled": len(already)}

	issued = []
	for name in pending:
		try:
			out = issue_for_stock_entry(frappe.get_doc("Stock Entry", name))
			issued.append({"stock_entry": name, "codes": len(out)})
			frappe.db.commit()
		except Exception:
			frappe.db.rollback()
			frappe.log_error(frappe.get_traceback(), f"Chemical QR – backfill {name}")
	return {"issued": issued, "already_labelled": len(already)}
