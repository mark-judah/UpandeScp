"""Syncing a spray session that was carried out offline.

A supervisor with no signal scans the chemicals, makes the mix, sprays, and finishes. The
handset holds a **token**: the ordered log of what happened and when. This module replays
that log into the documents it should have created at the time — a Manufacture and a
Material Issue posted at the moments they actually happened, so the cost lands in the
month the spray did.

## Why the times cannot simply be trusted, and why that turns out not to matter

The moments come from a handset, whose clock may be wrong. Rather than trusting it,
refusing it, or asking the operator to promise it is right, the postings are **clamped to
a floor derived from data**:

    anchor  = the transfer Stock Entry's posting moment  (raws provably in the CSU)
    mix_at  = max(token.mix_at,   anchor)
    end_at  = max(token.ended_at, mix_at + 1s)

A wrong clock can then only push a posting *later*, never behind the moment its inputs
arrived. Proven in `test_offline_token_mechanics.py`: the ledger refuses a consumption
dated before the transfer that delivered it, so the floor is real and not merely polite.

The device's measured clock skew is recorded on the token anyway, so a suspect timestamp
is auditable rather than invisible.

## Why one call and not four

`register_csu_scan` → `manufacture_tank_mix` → `start_spray_session` → `end_spray_session`
is a state machine: each step refuses unless the previous one happened. Queued separately
they can interleave across sessions and half-fail, leaving a plan in a state nobody chose.
Replayed here in one transaction, a session either lands whole or not at all.

## Why it pre-flights instead of letting the ledger object

The ledger *will* stop an impossible session — with `NegativeStockError` naming a warehouse
the supervisor has never heard of, halfway through a transaction. The guard below reaches
the same conclusions first, in words about chemicals and dates, before anything is
written.

**Valuation is never waived.** `allow_zero_valuation_rate` would make any of this post, at
zero cost, defeating the reason for dating it correctly. A mix with no value is refused and
reported, exactly as `3_issue_manufactured_console_v2.py` skips rather than "issuing at a
zero value".
"""
from __future__ import annotations

import json
from datetime import datetime, timezone as _tz

import frappe
from frappe.utils import add_to_date, flt, get_datetime, now_datetime

from upande_scp.serverscripts.spray_plan_creator import spray_session as SS

TOKEN = "Spray Session Token"
AFP_TYPE = "Application Floor Plan"
TRANSFER_PURPOSE = "Material Transfer for Manufacture"

#: A session older than this is recorded but not posted: it is surfaced for a human
#: instead. Backdating that far can land behind entries that already consumed the same
#: stock, and re-valuing those is not something a sync should decide on its own.
MAX_AGE_DAYS = 7

#: Gap between the manufacture and the issue when the recorded moments would otherwise
#: collide. Same-second posting is accepted by ERPNext — measured, not assumed — so this
#: is belt-and-braces for legibility rather than a correctness requirement.
ORDER_GAP_SECONDS = 1


# ────────────────────────────── the clock ────────────────────────────────────


@frappe.whitelist()
def server_clock() -> dict:
	"""The server's clock, for the handset to measure its own skew against.

	Cheap and read-only, called on login and before each sync. The client stores
	`device_now - server_now` and applies it to offline stamps, so a wrong phone clock is
	corrected rather than merely flagged. Returns UTC as well, because the wire format is
	UTC and the client should not have to reason about zones.
	"""
	from upande_scp.serverscripts.common.timezone import erp_timezone

	return {
		"server_now": str(now_datetime()),
		"utc_now": datetime.now(_tz.utc).strftime("%Y-%m-%d %H:%M:%S"),
		"timezone": erp_timezone(),
	}


def _as_payload(payload):
	if isinstance(payload, str):
		payload = json.loads(payload or "{}")
	return payload or {}


def _moment(value):
	"""Read a client moment. Returns None rather than guessing."""
	if not value:
		return None
	try:
		return get_datetime(value)
	except Exception:
		return None


# ─────────────────────────────── the guard ───────────────────────────────────


def transfer_anchor(work_order: str):
	"""The latest submitted transfer into the CSU for this plan.

	The honest floor for everything downstream: on that moment the raw chemicals are
	provably in the CSU, so a manufacture posted then cannot fail on stock. Taken from
	`redate_chain_to_transfer_console.py`, which established the principle against real
	data.
	"""
	rows = frappe.db.sql(
		"""SELECT se.name, se.posting_date, se.posting_time
		   FROM `tabStock Entry` se
		   WHERE se.work_order = %s AND se.purpose = %s AND se.docstatus = 1
		   ORDER BY se.posting_date DESC, se.posting_time DESC
		   LIMIT 1""",
		(work_order, TRANSFER_PURPOSE),
		as_dict=True,
	)
	if not rows:
		return None, None
	row = rows[0]
	return row.name, get_datetime(f"{row.posting_date} {row.posting_time}")


def resolve_moments(payload: dict, anchor) -> dict:
	"""Clamp the token's moments so they cannot precede their own inputs.

	`max()` in both places: a wrong device clock can only ever push a posting later. This
	is what makes the design safe without the app having to be trusted.
	"""
	mix = _moment(payload.get("mix_at")) or anchor or now_datetime()
	started = _moment(payload.get("started_at")) or mix
	ended = _moment(payload.get("ended_at")) or started

	if anchor and mix < anchor:
		mix = anchor
	if started < mix:
		started = mix
	floor = add_to_date(mix, seconds=ORDER_GAP_SECONDS)
	if ended < floor:
		ended = floor
	return {"mix_at": mix, "started_at": started, "ended_at": ended}


@frappe.whitelist()
def preflight(payload) -> dict:
	"""Everything that would stop this token, decided before anything is written.

	Read-only and whitelisted so the handset can warn a supervisor while they still have
	signal, rather than discovering it at sync.
	"""
	payload = _as_payload(payload)
	work_order = payload.get("work_order")
	problems: list[str] = []
	notes: list[str] = []

	if not work_order or not frappe.db.exists("Work Order", work_order):
		return {"ok": False, "problems": ["that spray plan does not exist"], "notes": []}

	wo = frappe.get_doc("Work Order", work_order)
	if wo.custom_type != AFP_TYPE:
		problems.append(f"{work_order} is not an Application Floor Plan")

	token = payload.get("token")
	existing = frappe.db.get_value(
		TOKEN, token, ["name", "status"], as_dict=True
	) if token else None
	if existing and existing.status == "Synced":
		return {
			"ok": True, "already_synced": True, "problems": [],
			"notes": ["this session has already been applied"],
		}

	anchor_se, anchor = transfer_anchor(work_order)
	if not anchor_se:
		problems.append(
			"no submitted chemical transfer for this plan, so there is nothing to date "
			"the mix from"
		)

	# The scanned set has to be the plan's set. A token describing different chemicals is
	# describing a different plan.
	required = {r.item_code for r in (wo.required_items or []) if r.item_code}
	scanned = {
		s.get("item_code") for s in (payload.get("scans") or []) if s.get("item_code")
	}
	missing = sorted(required - scanned)
	extra = sorted(scanned - required)
	if missing:
		problems.append(f"not scanned: {', '.join(missing)}")
	if extra:
		problems.append(f"scanned but not on the plan: {', '.join(extra)}")

	# Every raw has to be in the CSU as of the anchor, or the manufacture cannot consume
	# it. Checked here so the message names the chemical rather than a warehouse.
	if anchor and wo.wip_warehouse:
		for row in (wo.required_items or []):
			if not row.item_code:
				continue
			have = _qty_as_of(row.item_code, wo.wip_warehouse, anchor)
			if have + 0.0001 < flt(row.required_qty):
				problems.append(
					f"{row.item_code}: {flt(row.required_qty):g} needed in the CSU on "
					f"{anchor:%Y-%m-%d %H:%M} but only {have:g} was there"
				)

	moments = resolve_moments(payload, anchor)
	reported = _moment(payload.get("ended_at"))
	if reported and moments["ended_at"] > reported:
		notes.append(
			"the recorded times were adjusted forward so nothing is dated before the "
			"chemicals reached the CSU"
		)

	age_days = (now_datetime() - moments["mix_at"]).days
	if age_days > MAX_AGE_DAYS:
		problems.append(
			f"this session is {age_days} days old (limit {MAX_AGE_DAYS}); it needs a "
			"person to look at it rather than being posted automatically"
		)

	# Costing. A tank mix with no value would post at zero and quietly lose the spray's
	# cost, so it is refused here rather than waived at the ledger.
	fg = wo.production_item
	if fg and not _has_valuation(fg, wo.custom_greenhouse or wo.fg_warehouse):
		notes.append(
			f"{fg} has no valuation yet; if the manufacture cannot value it the sync will "
			"stop rather than post at zero cost"
		)

	state = wo.workflow_state or ""
	if state not in ("Chemical Issued", SS.STATE_TANK_MIX_MANUFACTURED,
	                 SS.STATE_SPRAYING_IN_PROGRESS, SS.STATE_COMPLETED):
		problems.append(f"a plan in {state or 'no state'} cannot take a spray session")

	return {
		"ok": not problems,
		"problems": problems,
		"notes": notes,
		"anchor": str(anchor) if anchor else None,
		"anchor_stock_entry": anchor_se,
		"resolved": {k: str(v) for k, v in moments.items()},
		"state": state,
		"already_synced": False,
	}


def _qty_as_of(item_code: str, warehouse: str, moment) -> float:
	"""Balance of an item in a warehouse at a past moment, from the ledger."""
	rows = frappe.db.sql(
		"""SELECT COALESCE(SUM(actual_qty), 0) q FROM `tabStock Ledger Entry`
		   WHERE item_code = %s AND warehouse = %s AND is_cancelled = 0
		     AND posting_datetime <= %s""",
		(item_code, warehouse, moment),
		as_dict=True,
	)
	return flt(rows[0]["q"]) if rows else 0.0


def _has_valuation(item_code: str, warehouse: str | None) -> bool:
	rate = frappe.db.get_value("Item", item_code, "valuation_rate")
	if flt(rate) > 0:
		return True
	if not warehouse:
		return False
	return flt(
		frappe.db.get_value(
			"Bin", {"item_code": item_code, "warehouse": warehouse}, "valuation_rate"
		)
	) > 0


# ─────────────────────────────── the sync ────────────────────────────────────


@frappe.whitelist()
def sync_spray_session(payload) -> dict:
	"""Apply one offline session: scans, manufacture, start, end — atomically.

	Idempotent on the token: a re-sync returns what the first one created rather than
	creating it again. The handset's own id cannot carry that guarantee, because it lives
	in the handset's storage and does not survive a reinstall.
	"""
	payload = _as_payload(payload)
	token = (payload.get("token") or "").strip()
	work_order = payload.get("work_order")
	if not token:
		frappe.throw("A session needs a token.")
	if not work_order:
		frappe.throw("A session needs a spray plan.")

	existing = frappe.db.get_value(TOKEN, token, "status")
	if existing == "Synced":
		return _result(token, already=True)

	check = preflight(payload)
	doc = _upsert_token(token, payload, check)
	if not check["ok"]:
		frappe.db.set_value(TOKEN, token, {
			"status": "Refused",
			"refusal": "\n".join(check["problems"]),
		}, update_modified=True)
		frappe.db.commit()
		frappe.throw(
			"This session cannot be applied:\n- " + "\n- ".join(check["problems"])
		)

	moments = resolve_moments(payload, get_datetime(check["anchor"]) if check["anchor"] else None)
	wo_state = frappe.db.get_value("Work Order", work_order, "workflow_state") or ""
	produced: dict = {}

	try:
		# 1. the scans, each at the moment it was taken. They do not build anything —
		#    manufacture is a separate explicit step, which is where the mix moment lands.
		if wo_state == "Chemical Issued":
			_replay_scans(payload, work_order)
			made = SS.manufacture_tank_mix(
				work_order, posting_moment=moments["mix_at"]
			)
			produced["manufacture"] = (made or {}).get("manufacture_se")
			produced["sal"] = (made or {}).get("sal")

		# 2. start, at the recorded moment
		state = frappe.db.get_value("Work Order", work_order, "workflow_state")
		if state == SS.STATE_TANK_MIX_MANUFACTURED:
			# `enforce_cutoff=False`: the spray already happened. The cutoff governs whether
			# work may START late, not whether a completed spray may be written down —
			# enforcing it here would silently discard the only record of real work. The
			# session is flagged `past_cutoff` on the token instead, so it is visible and
			# reportable rather than lost.
			SS.start_spray_session(
				work_order,
				started_at=moments["started_at"],
				enforce_cutoff=False,
				employee=payload.get("employee") or _supervisor_of(work_order),
			)

		# 3. end — submits the logsheet and fires the Material Issue at the spray's own
		#    moment, which is the entry that decides the costing month.
		state = frappe.db.get_value("Work Order", work_order, "workflow_state")
		if state == SS.STATE_SPRAYING_IN_PROGRESS:
			closed = SS.end_spray_session(work_order, ended_at=moments["ended_at"])
			# Taken from the return value, not searched for afterwards: the Material Issue
			# deliberately leaves its `work_order` link unset (so it causes no Work Order
			# side effects), which means there is nothing to find it by.
			produced["issue"] = (closed or {}).get("material_issue")
			produced["sal"] = (closed or {}).get("sal_submitted") or produced.get("sal")
	except Exception as e:
		frappe.db.rollback()
		frappe.db.set_value(TOKEN, token, {
			"status": "Refused",
			"refusal": str(e)[:1000],
		}, update_modified=True)
		frappe.db.commit()
		raise

	_stamp_result(token, work_order, produced)
	frappe.db.commit()
	return _result(token)


def _replay_scans(payload: dict, work_order: str) -> None:
	"""Register each scan at the moment it was actually taken.

	Scans build nothing on their own — they are the audit trail, and each carries its own
	time so a synced session shows when the supervisor was at the CSU rather than when the
	handset found signal. The label codes go through the same verification as an online
	scan, so an offline session cannot launder a label from another plan.
	"""
	# Who actually took the chemical, not who is syncing. Falls back to the session user
	# when the token does not say — but for a replayed session that is the wrong person, and
	# may be a different person entirely from the one who stood at the CSU.
	employee = payload.get("employee") or _supervisor_of(work_order)

	# The CSU is mandatory on the scan row, and the server already knows it — it is the
	# plan's own `wip_warehouse`, where the tank mix is made. Defaulted here rather than
	# required from the handset: asking the client to echo back something the server holds
	# is only an opportunity for the two to disagree.
	csu = frappe.db.get_value("Work Order", work_order, "wip_warehouse")

	for scan in (payload.get("scans") or []):
		item_code = scan.get("item_code")
		if not item_code:
			continue
		SS.register_csu_scan(
			work_order=work_order,
			item_code=item_code,
			qr_payload=scan.get("code"),
			csu_warehouse=scan.get("csu_warehouse") or csu,
			scanned_at=scan.get("scanned_at"),
			employee=employee,
		)


def _supervisor_of(work_order: str) -> str | None:
	"""The plan's own supervisor, as a fallback for whom to credit a replayed scan.

	Reuses the resolution the Material Issue already relies on, which reads the spray team
	rather than the session — so a sync run by an office user still attributes the work to
	the field.
	"""
	try:
		from upande_scp.serverscripts.spray_plan_creator.auto_material_issue import (
			resolve_supervisor_employee,
		)

		return resolve_supervisor_employee(frappe.get_doc("Work Order", work_order))
	except Exception:
		return None


def _upsert_token(token: str, payload: dict, check: dict):
	"""Record the token before doing anything with it.

	Written first on purpose: a session that fails to apply still happened in the field,
	and the reason it was refused is worth more than a clean table.
	"""
	work_order = payload.get("work_order")
	wo = frappe.db.get_value(
		"Work Order", work_order, ["custom_greenhouse"], as_dict=True
	) or {}
	greenhouse = wo.get("custom_greenhouse")
	farm = frappe.db.get_value("Warehouse", greenhouse, "custom_farm") if greenhouse else None
	resolved = check.get("resolved") or {}

	if frappe.db.exists(TOKEN, token):
		doc = frappe.get_doc(TOKEN, token)
	else:
		doc = frappe.new_doc(TOKEN)
		doc.token = token

	doc.work_order = work_order
	doc.greenhouse = greenhouse
	doc.farm = farm
	doc.mix_at = resolved.get("mix_at")
	doc.started_at = resolved.get("started_at")
	doc.ended_at = resolved.get("ended_at")
	doc.device_skew_seconds = int(flt(payload.get("device_skew_seconds")))
	doc.past_cutoff = 1 if _started_past_cutoff(work_order, resolved.get("started_at")) else 0
	doc.status = "Pending"
	doc.scans = []
	for scan in (payload.get("scans") or []):
		doc.append("scans", {
			"item_code": scan.get("item_code"),
			"code": scan.get("code"),
			"scanned_at": _moment(scan.get("scanned_at")),
			"qty": flt(scan.get("qty")),
		})
	doc.flags.ignore_permissions = True
	doc.flags.ignore_links = True
	doc.save(ignore_permissions=True)
	frappe.db.commit()
	return doc


def _started_past_cutoff(work_order: str, started_at) -> bool:
	"""Whether the spray began after its daily cutoff.

	**Recorded, not refused.** The session happened; losing the record would be worse than
	flagging it, and a flag can be reported on while a refusal only teaches supervisors to
	stop syncing. Flip `postponement.assert_within_cutoff` in here to enforce instead.
	"""
	if not started_at:
		return False
	try:
		from upande_scp.serverscripts.spray_plan_creator import postponement

		status = postponement.cutoff_status(work_order)
		deadline = status.get("deadline")
		return bool(deadline and get_datetime(started_at) > get_datetime(deadline))
	except Exception:
		return False


def _stamp_result(token: str, work_order: str, produced: dict) -> None:
	"""Record what the replay created.

	Each document comes from the endpoint that made it. Only the Manufacture is looked up,
	because it carries a `work_order` link; the Material Issue does not — it is built without
	one on purpose, so that issuing has no Work Order side effects — and searching for it by
	warehouse and date would be guessing.
	"""
	manu = produced.get("manufacture") or SS._find_submitted_manufacture_se(work_order)
	sal = produced.get("sal") or frappe.db.get_value(
		"Work Order", work_order, "custom_spray_application_logsheet"
	)
	issue = produced.get("issue")
	frappe.db.set_value(TOKEN, token, {
		"status": "Synced",
		"manufacture_stock_entry": manu,
		"logsheet": sal,
		"issue_stock_entry": issue,
		"synced_at": now_datetime(),
		"synced_by": frappe.session.user,
		"refusal": None,
	}, update_modified=True)


def _result(token: str, already: bool = False) -> dict:
	row = frappe.db.get_value(
		TOKEN, token,
		["token", "work_order", "status", "mix_at", "started_at", "ended_at",
		 "manufacture_stock_entry", "issue_stock_entry", "logsheet", "past_cutoff",
		 "device_skew_seconds", "refusal"],
		as_dict=True,
	) or {}
	row["already_synced"] = already
	for key in ("mix_at", "started_at", "ended_at"):
		if row.get(key):
			row[key] = str(row[key])
	return row


@frappe.whitelist()
def list_tokens(status: str | None = None, limit: int = 100) -> list[dict]:
	filters = {"status": status} if status else {}
	return frappe.get_all(
		TOKEN,
		filters=filters,
		fields=[
			"name", "token", "work_order", "greenhouse", "farm", "status",
			"mix_at", "started_at", "ended_at", "past_cutoff",
			"device_skew_seconds", "manufacture_stock_entry", "issue_stock_entry",
			"synced_at", "synced_by", "refusal",
		],
		order_by="creation desc",
		limit_page_length=int(limit or 100),
	)
