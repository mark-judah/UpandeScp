"""The daily scouting-alert digest: one email per person at 17:00 EAT (spec §3, D4).

The hourly scheduler calls ``send_alert_digest``. It sends from the 17:00
hour on the farms' clock (Africa/Nairobi — not the site's System Settings time
zone, Asia/Kolkata on kaitet.local, and not the server's UTC), and only once
that EAT day (Redis ``SET NX`` per date, so two workers cannot both send).
Each recipient gets one email listing the Open alerts raised or escalated that
day on the farms D4 would notify them for — recomputed here, so an alert
carried silently into a new week still reaches the digest. No alerts, no email.
Live email sits at the free-Gmail cap, so this is the only email the feature
sends; there is never one email per alert.
"""

import frappe

from upande_scp.serverscripts.common import threshold_bands as B
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.reports.send_chemical_progress_email import _email_for
from upande_scp.serverscripts.scouting import thresholds_check as TC

DIGEST_HOUR = 17
DIGEST_GATE_PREFIX = "scp:alert_digest"
DIGEST_LOCK_SECONDS = 10 * 60
DIGEST_MARKER = "scp_alert_digest_on"


def build_digests(day) -> dict:
    """``{user: [alert]}`` — Open alerts raised on ``day`` (EAT), per D4 recipient."""
    if not frappe.db.table_exists(TC.DOCTYPE):
        return {}
    rows = frappe.get_all(
        TC.DOCTYPE,
        filters={"status": "Open", "raised_on": day},
        fields=TC.ALERT_FIELDS,
        order_by="farm asc, warehouse asc, observation asc",
        limit_page_length=0,
    )
    stations: dict = {}
    out: dict = {}
    for r in rows:
        if r.crop not in stations:
            stations[r.crop] = _common.station_word(r.crop)
        r["unit"] = B.unit_label(r.measure, stations[r.crop])
        for user in TC.recipients_for(r.farm, r.crop, r.action):
            out.setdefault(user, []).append(r)
    for alerts in out.values():
        alerts.sort(key=lambda r: (
            -B.ACTION_RANK.get(r.action, 0), r.farm or "", r.warehouse or "", r.observation or "",
        ))
    return out


def _figure(a) -> str:
    """``33.3% ± 4.1`` — or ``33.3%`` + "too clustered to judge" when the stored
    margin is meaningless (``_margin`` is the only correct reader of it)."""
    text = frappe.utils.escape_html(B.format_value(a.value, a.unit))
    margin = TC._margin(a)
    if margin is None:
        return f"{text} <span style='color:#777'>(too clustered to judge)</span>"
    return f"{text} <span style='color:#777'>± {frappe.utils.escape_html(str(margin))}</span>"


def render(alerts, day) -> str:
    """Compact HTML: one table, worst first. No emoji, no accent strips."""
    esc = frappe.utils.escape_html
    cell = "padding:4px 8px"
    rows = "".join(
        "<tr>"
        f"<td style='{cell}'><b>{esc(a.action)}</b></td>"
        f"<td style='{cell}'>{esc(a.warehouse)}</td>"
        f"<td style='{cell}'>{esc(a.observation)}{(' · ' + esc(a.stage)) if a.stage else ''}</td>"
        f"<td style='{cell};text-align:right'>{_figure(a)}</td>"
        f"<td style='{cell}'>{esc(a.reliability or '')}</td>"
        f"<td style='{cell}'>{esc(a.iso_week)}</td>"
        "</tr>"
        for a in alerts
    )
    head = "".join(
        f"<th align='{align}' style='{cell}'>{label}</th>"
        for label, align in (("Action", "left"), ("Greenhouse / block", "left"), ("Pest / disease", "left"),
                             ("Figure", "right"), ("Reliability", "left"), ("Week", "left"))
    )
    plural = "s" if len(alerts) != 1 else ""
    return (
        "<div style='font-family:Poppins,Arial,sans-serif;font-size:13px;color:#1a1a1a'>"
        f"<p>{len(alerts)} scouting alert{plural} raised on "
        f"{frappe.utils.formatdate(day, 'dd-MMM-yyyy')} on your farms. "
        "Scout first means the figure is unreliable: scout again before spraying.</p>"
        f"<table style='border-collapse:collapse'><tr style='background:#f2f2f2'>{head}</tr>{rows}</table>"
        "</div>"
    )


def _marker(user) -> str:
    """The user's last-digest marker, read straight from ``tabDefaultValue``.
    Not ``frappe.defaults.get_user_default``: that loads the user's User
    Permissions, and one pointing at a deleted doctype (kaitet.local has three)
    raises DoesNotExistError."""
    return frappe.db.get_value("DefaultValue", {"parent": user, "defkey": DIGEST_MARKER}, "defvalue") or ""


def _set_marker(user, value) -> None:
    """Upsert the marker row without the permission machinery."""
    name = frappe.db.get_value("DefaultValue", {"parent": user, "defkey": DIGEST_MARKER}, "name")
    if name:
        frappe.db.set_value("DefaultValue", name, "defvalue", value, update_modified=False)
    else:
        frappe.get_doc({
            "doctype": "DefaultValue", "parent": user, "parenttype": "__default",
            "parentfield": "system_defaults", "defkey": DIGEST_MARKER, "defvalue": value,
        }).db_insert()
    frappe.defaults.clear_defaults_cache(user)


def _done_on(user, day) -> bool:
    return _marker(user) >= day.isoformat()


def send_alert_digest(now=None) -> dict:
    """Hourly scheduler entry. From 17:00 EAT on, sends to each recipient whose
    stored last-digest date is before today and who has an Open alert raised
    today. The marker is a per-user default (DB), written only after that
    user's send succeeds, so a failure is retried on the next hourly run and a
    cache flush cannot cause a second round. The Redis key is only a short
    concurrency lock around one run."""
    now = (now or TC.now_eat()).astimezone(TC.EAT)
    if now.hour < DIGEST_HOUR:
        return {"skipped": "not the send hour", "hour": now.hour}
    day = now.date()
    lock = f"{DIGEST_GATE_PREFIX}:lock"
    if not TC.take_gate(lock, DIGEST_LOCK_SECONDS):
        return {"skipped": "already running"}
    sent, failed = [], []
    try:
        for user, alerts in sorted(build_digests(day).items()):
            try:
                if _done_on(user, day):
                    continue
                email = _email_for(user)
                if not email:
                    continue
                frappe.sendmail(
                    recipients=[email],
                    subject=f"Scouting alerts — {frappe.utils.formatdate(day, 'dd-MMM-yyyy')} ({len(alerts)})",
                    message=render(alerts, day),
                    reference_doctype=TC.DOCTYPE,
                )
                _set_marker(user, day.isoformat())
                frappe.db.commit()
                sent.append(email)
            except Exception:
                failed.append(user)
                frappe.log_error(frappe.get_traceback(), f"scouting alert digest: {user}")
    finally:
        TC.clear_gate(lock)
    return {"sent": len(sent), "recipients": sent, "failed": failed}
