"""Postponing a spray plan: the supervisor declares, the approver decides.

A plan that does not go out on its day is the normal case, and until now the system
had no way to say so. The options were to leave it sitting (where
``auto_cancel_dormant_plans`` eventually stopped it for being old) or to Stop it by
hand, which records that it was abandoned rather than moved.

## The rules

**Only up to Tank Mix Manufactured.** Postponement is allowed while the plan is
Pending Submission, Awaiting Approval, Approved or Chemical Issued. Once the tank mix
exists it is not a plan any more, it is mixed chemical with a short life — moving the
*date* would record a spray using a mix that is no longer what it was. Past that point
the plan is sprayed or Stopped, and the existing paths already do both.

**A daily cutoff.** On the plan's own spray date there is a deadline
(``spray_cutoff_time``, default 10:00). After it a supervisor can no longer declare a
postponement and the spray can no longer be started. Two different windows, on
purpose: the declaration gets ``postponement_grace_minutes`` of slack for the
supervisor standing in the field at 10:01, while starting a spray does not — the point
of the cutoff is that a late spray is not a spray anyone planned for.

The cutoff binds a plan whose date has passed as well: a plan scheduled two days ago is
long past its deadline, which is what stops yesterday's plan being quietly sprayed
today.

**A bound on how far it moves.** ``postponement_max_days`` (default 7). Without one, a
plan can be deferred indefinitely, and a plan deferred indefinitely has been abandoned
without anybody saying so.

**The plan is re-dated, not re-created.** The same Work Order moves, and every
declaration — approved, rejected or withdrawn — is kept as a ``Spray Plan
Postponement`` row. A new Work Order per slip would double the records and break the
link to the chemicals already transferred against the original.

Both date fields move together. ``custom_scheduled_application_time`` is what the
operator sees and ``planned_start_date`` is ERPNext's own; they are written as a pair
at creation and drift if only one is updated.
"""
from __future__ import annotations

import frappe
from frappe.utils import (
	add_days,
	get_datetime,
	getdate,
	now_datetime,
)

from upande_scp.serverscripts.common.notifications import notify, users_for_farm

DOCTYPE = "Spray Plan Postponement"
AFP_TYPE = "Application Floor Plan"
SETTINGS = "Scouting and Crop Protection Settings"

#: States a plan may be postponed from. Deliberately stops before
#: ``Tank Mix Manufactured`` — see the module docstring.
POSTPONABLE_STATES = (
	"Pending Submission",
	"Awaiting Approval",
	"Approved",
	"Chemical Issued",
)

#: The state that means the chemicals are already mixed.
STATE_MANUFACTURED = "Tank Mix Manufactured"

DEFAULT_CUTOFF = "10:00:00"
DEFAULT_MAX_DAYS = 7

SUPERVISOR_ROLES = {"SCP Spray Supervisor"}
APPROVER_ROLES = {"SCP Spray Plan Approver", "SCP General Manager"}
ELEVATED = {"SCP General Manager", "System Manager", "Administrator"}


# ────────────────────────────── the deadline ─────────────────────────────────


def _settings():
	return frappe.get_cached_doc(SETTINGS)


def cutoff_time() -> str:
	"""The daily deadline, as ``HH:MM:SS``.

	A midnight value is treated as **unset**, not as a policy. ``00:00:00`` means the
	deadline passed before the day began, which locks every plan on the site out of
	both spraying and postponement — and a Time field left alone, or written by a
	half-finished save, lands there. No farm ever wants that as a rule, so it falls
	back to the default instead of bricking the day. (A truthiness check does not
	catch it: ``"0:00:00"`` is a non-empty string.)
	"""
	value = getattr(_settings(), "spray_cutoff_time", None)
	text = str(value or "").strip()
	if not text or set(text) <= set("0:. "):
		return DEFAULT_CUTOFF
	return text


def max_days() -> int:
	try:
		return int(getattr(_settings(), "postponement_max_days", 0) or DEFAULT_MAX_DAYS)
	except (TypeError, ValueError):
		return DEFAULT_MAX_DAYS


def grace_minutes() -> int:
	try:
		return max(0, int(getattr(_settings(), "postponement_grace_minutes", 0) or 0))
	except (TypeError, ValueError):
		return 0


def deadline_for(scheduled) -> "frappe.utils.datetime.datetime | None":
	"""The moment a plan scheduled for `scheduled` stops being actionable.

	The plan's own date at the cutoff time — not the cutoff time today, which would
	leave a plan from last week permanently sprayable every morning.
	"""
	if not scheduled:
		return None
	day = getdate(scheduled)
	return get_datetime(f"{day} {cutoff_time()}")


def scheduled_of(wo) -> "frappe.utils.datetime.datetime | None":
	"""The plan's scheduled moment, from whichever field carries it."""
	value = (
		getattr(wo, "custom_scheduled_application_time", None)
		or getattr(wo, "planned_start_date", None)
	)
	return get_datetime(value) if value else None


def cutoff_status(work_order: str) -> dict:
	"""Where a plan stands against its deadline. Read-only; safe for any caller."""
	wo = frappe.db.get_value(
		"Work Order",
		work_order,
		["name", "workflow_state", "custom_scheduled_application_time",
		 "planned_start_date", "custom_greenhouse"],
		as_dict=True,
	)
	if not wo:
		frappe.throw(f"{work_order} does not exist.")

	scheduled = scheduled_of(wo)
	deadline = deadline_for(scheduled)
	now = now_datetime()
	if not deadline:
		# No scheduled date: nothing to be late for. Better than treating an
		# unscheduled plan as permanently expired.
		return {
			"work_order": work_order, "scheduled": None, "deadline": None,
			"past_cutoff": False, "can_start": True, "can_postpone": True,
			"state": wo.workflow_state,
		}

	past = now > deadline
	grace_end = get_datetime(deadline) if not grace_minutes() else frappe.utils.add_to_date(
		deadline, minutes=grace_minutes()
	)
	return {
		"work_order": work_order,
		"scheduled": str(scheduled),
		"deadline": str(deadline),
		"grace_until": str(grace_end),
		"past_cutoff": past,
		# Starting a spray gets no grace: a late spray is not one anybody planned for.
		"can_start": not past,
		"can_postpone": (
			now <= grace_end and wo.workflow_state in POSTPONABLE_STATES
		),
		"state": wo.workflow_state,
	}


def assert_within_cutoff(work_order: str) -> None:
	"""Refuse to start a spray past its deadline. Called from the session opener."""
	status = cutoff_status(work_order)
	if status["can_start"]:
		return
	frappe.throw(
		f"This spray was scheduled for {status['scheduled']} and its cutoff "
		f"({status['deadline']}) has passed, so it can no longer be started. "
		"Postpone it to a new date instead.",
		frappe.ValidationError,
	)


# ───────────────────────────────── guards ────────────────────────────────────


def _is_elevated(user: str | None = None) -> bool:
	return bool(set(frappe.get_roles(user or frappe.session.user)) & ELEVATED)


def _assert_can_declare() -> None:
	roles = set(frappe.get_roles(frappe.session.user))
	if roles & (SUPERVISOR_ROLES | ELEVATED | APPROVER_ROLES):
		return
	frappe.throw(
		"Only a spray supervisor can postpone a spray.", frappe.PermissionError
	)


def _farm_of(wo) -> str | None:
	"""The farm a plan belongs to, via its greenhouse warehouse."""
	gh = getattr(wo, "custom_greenhouse", None)
	return frappe.db.get_value("Warehouse", gh, "custom_farm") if gh else None


def _assert_can_decide(farm: str | None) -> None:
	"""The plan's own approvers decide, or the GM.

	Reuses the farm's configured ``Farm Spray Plan Approver`` rows rather than
	introducing a second list — two lists of approvers drift, and the people who
	approved the plan are the ones who should see it slip.
	"""
	if _is_elevated():
		return
	roles = set(frappe.get_roles(frappe.session.user))
	if not (roles & APPROVER_ROLES):
		frappe.throw(
			"Only a spray-plan approver can decide a postponement.",
			frappe.PermissionError,
		)
	if not farm:
		return
	assigned = frappe.db.exists(
		"Farm Spray Plan Approver",
		{"parent": farm, "parenttype": "Farm", "user": frappe.session.user},
	)
	if not assigned:
		frappe.throw(
			f"You are not an approver for {farm}.", frappe.PermissionError
		)


# ──────────────────────────────── declare ────────────────────────────────────


@frappe.whitelist()
def declare(work_order: str, to_date: str, reason: str) -> dict:
	"""A supervisor declares that a plan will not go out today.

	Nothing moves yet — the plan keeps its date until the postponement is approved, so
	a pending request cannot quietly change what the store and the sprayers are
	working to.
	"""
	_assert_can_declare()
	if not (reason or "").strip():
		frappe.throw("Say why the spray is being postponed.")

	wo = frappe.get_doc("Work Order", work_order)
	if wo.custom_type != AFP_TYPE:
		frappe.throw(f"{work_order} is not an Application Floor Plan.")

	state = wo.workflow_state or "Pending Submission"
	if state not in POSTPONABLE_STATES:
		if state == STATE_MANUFACTURED:
			frappe.throw(
				"The tank mix for this plan has already been made, so it cannot be "
				"postponed — a mix does not keep, and moving the date would record a "
				"spray using chemical that is no longer what it was. Spray it, or stop "
				"the plan.",
			)
		frappe.throw(
			f"A plan in {state} cannot be postponed.",
		)

	existing = frappe.db.exists(
		DOCTYPE, {"work_order": work_order, "status": "Pending"}
	)
	if existing:
		frappe.throw(
			f"{work_order} already has a postponement awaiting a decision ({existing})."
		)

	scheduled = scheduled_of(wo)
	status = cutoff_status(work_order)
	if not status["can_postpone"]:
		frappe.throw(
			f"The deadline for postponing this spray ({status.get('grace_until')}) has "
			"passed. It can no longer be moved or started — ask the General Manager.",
			frappe.ValidationError,
		)

	target = get_datetime(to_date)
	if scheduled and target <= scheduled:
		frappe.throw("A postponement has to move the spray later, not earlier.")
	limit = add_days(getdate(scheduled or now_datetime()), max_days())
	if getdate(target) > limit:
		frappe.throw(
			f"That is more than {max_days()} days past the original date "
			f"({limit}). A plan pushed further than this has been abandoned rather "
			"than moved — stop it instead.",
		)

	farm = _farm_of(wo)
	doc = frappe.get_doc({
		"doctype": DOCTYPE,
		"work_order": work_order,
		"farm": farm,
		"greenhouse": wo.custom_greenhouse,
		"state_at_declaration": state,
		"from_datetime": scheduled,
		"to_datetime": target,
		"status": "Pending",
		"reason": reason,
		"declared_by": frappe.session.user,
		"declared_on": now_datetime(),
	})
	doc.flags.ignore_permissions = True
	doc.insert(ignore_permissions=True)

	actor = frappe.db.get_value("User", frappe.session.user, "full_name") or frappe.session.user
	notify(
		_approvers_of(farm) + users_for_farm(farm),
		f"Postponement requested for {wo.custom_greenhouse or work_order}",
		f"{actor} asks to move {work_order} from {scheduled} to {target}.\n\n"
		f"Reason: {reason}",
		ref_doctype=DOCTYPE,
		ref_name=doc.name,
		category="transfer",
	)
	frappe.db.commit()
	return _as_dict(doc)


def _approvers_of(farm: str | None) -> list[str]:
	if not farm:
		return []
	return frappe.get_all(
		"Farm Spray Plan Approver",
		filters={"parent": farm, "parenttype": "Farm"},
		pluck="user",
	)


# ──────────────────────────────── decide ─────────────────────────────────────


@frappe.whitelist()
def decide(name: str, decision: str, note: str | None = None) -> dict:
	"""Approve or reject a postponement. Approving is what moves the plan.

	The re-date happens here rather than at declaration so a plan never sits on a date
	nobody agreed to, and the audit row records both the request and the answer.
	"""
	doc = frappe.get_doc(DOCTYPE, name)
	if doc.status != "Pending":
		frappe.throw(f"{name} was already {doc.status.lower()}.")
	_assert_can_decide(doc.farm)

	decision = (decision or "").lower()
	if decision not in ("approve", "reject"):
		frappe.throw("Decision must be approve or reject.")

	wo = frappe.get_doc("Work Order", doc.work_order)
	state = wo.workflow_state or "Pending Submission"
	if decision == "approve" and state not in POSTPONABLE_STATES:
		# The plan moved on while the request sat waiting.
		frappe.throw(
			f"{doc.work_order} is now {state}, so this postponement can no longer be "
			"applied. Reject it and deal with the plan where it is.",
		)

	doc.status = "Approved" if decision == "approve" else "Rejected"
	doc.decided_by = frappe.session.user
	doc.decided_on = now_datetime()
	doc.decision_note = note
	doc.flags.ignore_permissions = True
	doc.save(ignore_permissions=True)

	if decision == "approve":
		_apply(doc, wo)

	actor = frappe.db.get_value("User", frappe.session.user, "full_name") or frappe.session.user
	body = (
		f"{actor} {doc.status.lower()} the postponement of {doc.work_order}.\n\n"
		f"Requested: {doc.from_datetime} → {doc.to_datetime}\n"
		f"Reason given: {doc.reason}"
	)
	if note:
		body += f"\n\nNote: {note}"
	notify(
		list({doc.declared_by, *users_for_farm(doc.farm)} - {None}),
		f"Postponement {doc.status.lower()}: {doc.greenhouse or doc.work_order}",
		body,
		ref_doctype=DOCTYPE,
		ref_name=doc.name,
		category="transfer",
	)
	frappe.db.commit()
	return _as_dict(doc)


def _apply(doc, wo) -> None:
	"""Move the plan's date. Both fields, because they are a pair.

	``custom_scheduled_application_time`` is what the operator sees;
	``planned_start_date`` is what ERPNext's own scheduling reads. They are written
	together at creation, so updating one alone makes the plan say two things.
	"""
	frappe.db.set_value(
		"Work Order",
		wo.name,
		{
			"custom_scheduled_application_time": doc.to_datetime,
			"planned_start_date": doc.to_datetime,
		},
		update_modified=True,
	)
	try:
		wo.add_comment(
			"Workflow",
			f"Spray postponed from {doc.from_datetime} to {doc.to_datetime} by "
			f"{frappe.session.user} ({doc.name}). Reason: {doc.reason}",
		)
	except Exception:
		frappe.log_error(frappe.get_traceback(), "postponement: add_comment failed")


@frappe.whitelist()
def withdraw(name: str, note: str | None = None) -> dict:
	"""The declarer takes back a request they no longer need."""
	doc = frappe.get_doc(DOCTYPE, name)
	if doc.status != "Pending":
		frappe.throw(f"{name} was already {doc.status.lower()}.")
	if doc.declared_by != frappe.session.user and not _is_elevated():
		frappe.throw(
			"Only whoever declared this postponement can withdraw it.",
			frappe.PermissionError,
		)
	doc.status = "Withdrawn"
	doc.decided_by = frappe.session.user
	doc.decided_on = now_datetime()
	doc.decision_note = note
	doc.flags.ignore_permissions = True
	doc.save(ignore_permissions=True)
	frappe.db.commit()
	return _as_dict(doc)


# ────────────────────────────────── reads ────────────────────────────────────


def _as_dict(doc) -> dict:
	return {
		"name": doc.name,
		"work_order": doc.work_order,
		"farm": doc.farm,
		"greenhouse": doc.greenhouse,
		"state_at_declaration": doc.state_at_declaration,
		"from_datetime": str(doc.from_datetime) if doc.from_datetime else None,
		"to_datetime": str(doc.to_datetime) if doc.to_datetime else None,
		"status": doc.status,
		"reason": doc.reason,
		"declared_by": doc.declared_by,
		"declared_on": str(doc.declared_on) if doc.declared_on else None,
		"decided_by": doc.decided_by,
		"decided_on": str(doc.decided_on) if doc.decided_on else None,
		"decision_note": doc.decision_note,
	}


@frappe.whitelist()
def list_postponements(status: str | None = None, farm: str | None = None,
                       limit: int = 100) -> list[dict]:
	filters: dict = {}
	if status:
		filters["status"] = status
	if farm:
		filters["farm"] = farm
	elif not _is_elevated():
		# A supervisor sees their own farms' slips, not every farm's.
		from upande_scp.serverscripts.spray_plan_creator.scope import _resolve_user_scope

		farms = _resolve_user_scope(frappe.session.user).get("farms") or []
		filters["farm"] = ("in", list(farms) or [""])
	return frappe.get_all(
		DOCTYPE,
		filters=filters,
		fields=[
			"name", "work_order", "farm", "greenhouse", "state_at_declaration",
			"from_datetime", "to_datetime", "status", "reason", "declared_by",
			"declared_on", "decided_by", "decided_on", "decision_note",
		],
		order_by="creation desc",
		limit_page_length=int(limit or 100),
	)


@frappe.whitelist()
def postponement_settings() -> dict:
	"""What the client needs to show the deadline before anybody tries to miss it."""
	return {
		"cutoff_time": cutoff_time(),
		"max_days": max_days(),
		"grace_minutes": grace_minutes(),
		"postponable_states": list(POSTPONABLE_STATES),
	}


@frappe.whitelist()
def history_for(work_order: str) -> list[dict]:
	"""Every declaration against one plan, decided or not.

	Rejected and withdrawn rows are included: why a plan happened when it did is as
	much about the slips that were refused as the ones that were granted.
	"""
	return frappe.get_all(
		DOCTYPE,
		filters={"work_order": work_order},
		fields=[
			"name", "from_datetime", "to_datetime", "status", "reason",
			"declared_by", "declared_on", "decided_by", "decided_on",
			"decision_note", "state_at_declaration",
		],
		order_by="creation asc",
	)


@frappe.whitelist()
def postponable_plans(on_date: str | None = None, limit: int = 200) -> list[dict]:
	"""Plans a supervisor could postpone, with where each stands against its deadline.

	Scoped to the user's farms unless they are elevated. Includes plans whose date has
	already passed — those are exactly the ones needing attention, and hiding them
	would leave a stale plan with no route forward but the Stop button.
	"""
	_assert_can_declare()

	filters: dict = {
		"custom_type": AFP_TYPE,
		"workflow_state": ("in", list(POSTPONABLE_STATES)),
		"status": ("!=", "Stopped"),
	}
	if on_date:
		filters["planned_start_date"] = (
			"between", [f"{on_date} 00:00:00", f"{on_date} 23:59:59"]
		)

	rows = frappe.get_all(
		"Work Order",
		filters=filters,
		fields=[
			"name", "workflow_state", "custom_greenhouse",
			"custom_scheduled_application_time", "planned_start_date",
		],
		order_by="planned_start_date asc",
		limit_page_length=int(limit or 200),
	)

	allowed = None
	if not _is_elevated():
		from upande_scp.serverscripts.spray_plan_creator.scope import _resolve_user_scope

		allowed = set(_resolve_user_scope(frappe.session.user).get("farms") or [])

	pending = set(
		frappe.get_all(DOCTYPE, filters={"status": "Pending"}, pluck="work_order")
	)

	out = []
	for r in rows:
		farm = frappe.db.get_value("Warehouse", r.custom_greenhouse, "custom_farm")
		if allowed is not None and farm not in allowed:
			continue
		scheduled = scheduled_of(r)
		deadline = deadline_for(scheduled)
		now = now_datetime()
		grace = (
			frappe.utils.add_to_date(deadline, minutes=grace_minutes())
			if deadline and grace_minutes()
			else deadline
		)
		out.append({
			"work_order": r.name,
			"state": r.workflow_state,
			"greenhouse": r.custom_greenhouse,
			"farm": farm,
			"scheduled": str(scheduled) if scheduled else None,
			"deadline": str(deadline) if deadline else None,
			"past_cutoff": bool(deadline and now > deadline),
			"can_postpone": bool((not grace) or now <= grace),
			"request_pending": r.name in pending,
		})
	return out
