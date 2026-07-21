"""Daily 'Chemical Planning Progress Update' email.

A monochrome digest of the Application Floor Plan work orders scheduled for the
day and how far each got through its lifecycle — approved, chemical issued
(biometric), labels printed, labels scanned, spraying started (by whom),
completed. Grouped per farm.

Recipients & scope:
  * General Manager / System Manager — all farms.
  * Spray Plan Approver — only their rostered farms (Farm Spray Plan Approver).
  * Spray Plan Creator — only their rostered farms (Farm Spray Plan Creator).

Each recipient gets ONE email with a section per farm they're entitled to,
covering only farms that actually have plans scheduled today (empties skipped).

Scheduling: the ``hourly`` scheduler calls ``send_chemical_progress_email``;
it sends once per day when the EAT hour matches the GM-configured send hour
(``progress_email_hour``, default 18) and the feature is enabled
(``progress_email_enabled``). ``progress_email_last_sent`` dedupes within a day.
"""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import frappe

from upande_scp.serverscripts.spray_plan_ops.spray_plan_approval import _derive_farm
from upande_scp.serverscripts.spray_plan_creator.lifecycle import AFP_TYPE, get_lifecycle

EAT = ZoneInfo("Africa/Nairobi")

# Lifecycle steps shown in the email, in order, with short labels.
EMAIL_STEPS = [
    ("created", "Created"),
    ("approved", "Approved"),
    ("chemical_issued", "Issued"),
    ("labels_printed", "Printed"),
    ("labels_scanned", "Scanned"),
    ("spraying_started", "Sprayed"),
    ("completed", "Done"),
]

# Monochrome palette.
INK = "#111111"
MUTED = "#777777"
LINE = "#cccccc"
PAPER = "#ffffff"
SOFT = "#f4f4f4"


# ───────────────────────────── data gathering ────────────────────────────────


def _wos_scheduled_on(target_date) -> list[dict]:
    return frappe.get_all(
        "Work Order",
        filters={
            "custom_type": AFP_TYPE,
            "docstatus": ("<", 2),
            "custom_scheduled_application_time": (
                "between",
                [f"{target_date} 00:00:00", f"{target_date} 23:59:59"],
            ),
        },
        fields=[
            "name",
            "custom_greenhouse",
            "custom_scheduled_application_time",
            "custom_spray_type",
        ],
        order_by="custom_greenhouse, custom_scheduled_application_time",
    )


def _group_by_farm(wos: list[dict]) -> dict[str, list[dict]]:
    by: dict[str, list[dict]] = {}
    for w in wos:
        farm = _derive_farm(w.get("custom_greenhouse")) or "Unassigned"
        by.setdefault(farm, []).append(w)
    return by


# ───────────────────────────── recipients ────────────────────────────────────


def _role_user_names(role: str) -> list[str]:
    return frappe.get_all(
        "Has Role",
        filters={"role": role, "parenttype": "User"},
        pluck="parent",
    )


def _recipient_farms(all_farms: set[str]) -> dict[str, set[str]]:
    """Map each entitled user (login) → the set of farms their email covers."""
    out: dict[str, set[str]] = {}
    for u in set(_role_user_names("SCP General Manager")) | set(_role_user_names("System Manager")):
        out.setdefault(u, set()).update(all_farms)
    for u in _role_user_names("SCP Spray Plan Approver"):
        farms = frappe.get_all(
            "Farm Spray Plan Approver", {"user": u, "parenttype": "Farm"}, pluck="parent"
        )
        out.setdefault(u, set()).update(farms)
    for u in _role_user_names("SCP Spray Plan Creator"):
        farms = frappe.get_all(
            "Farm Spray Plan Creator", {"user": u, "parenttype": "Farm"}, pluck="parent"
        )
        out.setdefault(u, set()).update(farms)
    out.pop("Administrator", None)
    out.pop("Guest", None)
    return out


def _email_for(user: str) -> str | None:
    enabled, email = frappe.db.get_value("User", user, ["enabled", "email"]) or (0, None)
    if not enabled:
        return None
    addr = email or user
    return addr if "@" in (addr or "") else None


# ───────────────────────────── HTML rendering ────────────────────────────────


def _chip(step: dict) -> str:
    status = step.get("status")
    label = step.get("label_short") or step.get("label")
    if status == "done":
        bg, fg, border, mark = INK, PAPER, INK, "✓"
    elif status == "current":
        bg, fg, border, mark = PAPER, INK, INK, "•"
    elif status == "warning":
        bg, fg, border, mark = PAPER, INK, INK, "✕"
    else:  # pending / skipped
        bg, fg, border, mark = PAPER, MUTED, LINE, "·"
    weight = "700" if status in ("done", "current", "warning") else "400"
    deco = "underline" if status == "warning" else "none"
    return (
        f'<td style="padding:0 3px;">'
        f'<div style="border:1px solid {border};background:{bg};color:{fg};'
        f'font:600 10px Arial,Helvetica,sans-serif;padding:4px 6px;white-space:nowrap;'
        f'text-align:center;border-radius:3px;font-weight:{weight};text-decoration:{deco};">'
        f'{mark} {label}</div></td>'
    )


def _wo_block(wo: dict) -> str:
    lc = get_lifecycle(wo["name"])
    steps = lc.get("steps", [])
    short = {k: v for k, v in EMAIL_STEPS}
    for s in steps:
        s["label_short"] = short.get(s["key"], s["label"])
    chips = "".join(_chip(s) for s in steps if s["key"] in short)

    # Key actors line (issued / sprayed / who).
    actors = []
    for s in steps:
        if s["key"] in ("chemical_issued", "spraying_started", "completed") and s.get("actor"):
            actors.append(f'{short.get(s["key"], s["label"])}: {s["actor"]}')
    actor_line = " &nbsp;·&nbsp; ".join(actors)

    sched = (wo.get("custom_scheduled_application_time") or "")
    sched_t = str(sched)[11:16] if sched else "—"
    state = lc.get("current_state", "")
    missed = lc.get("missed")
    stopped = lc.get("stopped")
    state_txt = "CANCELLED" if stopped else state.upper()
    state_extra = (
        f' <span style="border:1px solid {INK};padding:1px 4px;font-weight:700;">MISSED WINDOW</span>'
        if missed else ""
    )

    return f"""
    <div style="border:1px solid {LINE};border-radius:5px;padding:10px 12px;margin:0 0 8px;background:{PAPER};">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:6px;">
        <tr>
          <td style="font:700 13px Arial,Helvetica,sans-serif;color:{INK};">
            {wo.get('custom_greenhouse') or wo['name']}
            <span style="font-weight:400;color:{MUTED};font-size:11px;">&nbsp; {wo['name']}</span>
          </td>
          <td align="right" style="font:700 10px Arial,Helvetica,sans-serif;color:{INK};letter-spacing:.5px;">
            {state_txt}{state_extra}
            <span style="font-weight:400;color:{MUTED};">&nbsp; · &nbsp;{sched_t}</span>
          </td>
        </tr>
      </table>
      <table cellpadding="0" cellspacing="0"><tr>{chips}</tr></table>
      {f'<div style="margin-top:6px;font:400 10px Arial,Helvetica,sans-serif;color:{MUTED};">{actor_line}</div>' if actor_line else ''}
    </div>
    """


def _farm_section(farm: str, wos: list[dict]) -> str:
    blocks = "".join(_wo_block(w) for w in wos)
    return f"""
    <div style="margin:0 0 22px;">
      <div style="border-bottom:2px solid {INK};padding-bottom:4px;margin-bottom:10px;">
        <span style="font:700 15px Arial,Helvetica,sans-serif;color:{INK};letter-spacing:.5px;">{farm}</span>
        <span style="font:400 11px Arial,Helvetica,sans-serif;color:{MUTED};">
          &nbsp; {len(wos)} plan{'s' if len(wos) != 1 else ''} scheduled today</span>
      </div>
      {blocks}
    </div>
    """


def build_html(farm_to_wos: dict[str, list[dict]], target_date) -> str:
    date_str = frappe.utils.formatdate(target_date, "EEEE, dd MMM yyyy")
    sections = "".join(
        _farm_section(f, farm_to_wos[f]) for f in sorted(farm_to_wos) if farm_to_wos[f]
    )
    legend = (
        f'<table cellpadding="0" cellspacing="0" style="margin-top:4px;"><tr>'
        + _chip({"status": "done", "label_short": "done"})
        + _chip({"status": "current", "label_short": "in progress"})
        + _chip({"status": "pending", "label_short": "pending"})
        + _chip({"status": "warning", "label_short": "missed"})
        + "</tr></table>"
    )
    return f"""
    <div style="background:{SOFT};padding:20px 0;font-family:Arial,Helvetica,sans-serif;">
      <div style="max-width:680px;margin:0 auto;background:{PAPER};border:1px solid {LINE};">
        <div style="background:{INK};color:{PAPER};padding:16px 22px;">
          <div style="font-size:18px;font-weight:700;letter-spacing:.5px;">CHEMICAL PLANNING PROGRESS UPDATE</div>
          <div style="font-size:12px;color:#cccccc;margin-top:2px;">{date_str}</div>
        </div>
        <div style="padding:20px 22px;">
          {sections or f'<div style="color:{MUTED};font-size:13px;">No plans were scheduled today.</div>'}
          <div style="margin-top:18px;border-top:1px solid {LINE};padding-top:10px;">
            <div style="font:700 10px Arial;color:{MUTED};letter-spacing:.5px;margin-bottom:4px;">LEGEND</div>
            {legend}
          </div>
        </div>
        <div style="padding:12px 22px;border-top:1px solid {LINE};color:{MUTED};font-size:10px;">
          Upande SCP · automated daily digest of today's application floor plans.
        </div>
      </div>
    </div>
    """


# ───────────────────────────── send / triggers ───────────────────────────────


def _build_and_send(target_date) -> dict:
    """Core: build per-recipient emails for plans scheduled on target_date."""
    wos = _wos_scheduled_on(target_date)
    farm_to_wos = _group_by_farm(wos)
    all_farms = set(farm_to_wos)
    if not all_farms:
        return {"sent": 0, "recipients": [], "reason": "no plans scheduled"}

    recip_farms = _recipient_farms(all_farms)
    sent = []
    subject = "Chemical Planning Progress Update — " + frappe.utils.formatdate(
        target_date, "dd-MMM-yyyy"
    )
    for user, farms in recip_farms.items():
        mine = {f: farm_to_wos[f] for f in farms if f in farm_to_wos}
        if not mine:
            continue
        email = _email_for(user)
        if not email:
            continue
        try:
            frappe.sendmail(
                recipients=[email],
                subject=subject,
                message=build_html(mine, target_date),
                reference_doctype="Spray Plan Settings",
            )
            sent.append(email)
        except Exception:
            frappe.log_error(frappe.get_traceback(), f"chemical progress email: {email}")
    return {"sent": len(sent), "recipients": sent}


def send_chemical_progress_email() -> dict:
    """Hourly scheduler entry — sends once/day at the configured EAT hour."""
    try:
        s = frappe.get_single("Spray Plan Settings")
    except Exception:
        return {"enabled": False}
    if not getattr(s, "progress_email_enabled", 0):
        return {"enabled": False}

    now_eat = datetime.now(EAT)
    send_hour = int(getattr(s, "progress_email_hour", 18) or 18)
    if now_eat.hour != send_hour:
        return {"enabled": True, "skipped": "not the send hour", "hour": now_eat.hour}

    today = now_eat.date()
    last = getattr(s, "progress_email_last_sent", None)
    if last and frappe.utils.getdate(last) == today:
        return {"enabled": True, "skipped": "already sent today"}

    result = _build_and_send(today)
    frappe.db.set_value("Spray Plan Settings", None, "progress_email_last_sent", today)
    frappe.db.commit()
    return {"enabled": True, **result}


@frappe.whitelist()
def trigger_chemical_progress_email(target_date: str | None = None) -> dict:
    """Manual send (ignores the time gate) — for testing from Desk / console."""
    if not (set(frappe.get_roles(frappe.session.user)) & {"SCP General Manager", "System Manager", "Administrator"}):
        frappe.throw("Only the SCP General Manager can trigger this email.", frappe.PermissionError)
    target = frappe.utils.getdate(target_date) if target_date else datetime.now(EAT).date()
    return _build_and_send(target)


@frappe.whitelist()
def preview_chemical_progress_email(target_date: str | None = None, farm: str | None = None) -> str:
    """Return the HTML (all farms, or one) without sending — for a preview."""
    if not (set(frappe.get_roles(frappe.session.user)) & {"SCP General Manager", "System Manager", "Administrator", "SCP Spray Plan Approver", "SCP Spray Plan Creator"}):
        frappe.throw("Not permitted.", frappe.PermissionError)
    target = frappe.utils.getdate(target_date) if target_date else datetime.now(EAT).date()
    farm_to_wos = _group_by_farm(_wos_scheduled_on(target))
    if farm:
        farm_to_wos = {farm: farm_to_wos.get(farm, [])}
    return build_html(farm_to_wos, target)
