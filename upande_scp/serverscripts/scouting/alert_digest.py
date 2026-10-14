"""The daily scouting-alert digest: one email per person at 17:00 EAT (spec §3, D4).

The hourly scheduler calls ``send_alert_digest``. It sends from the 17:00
hour on the farms' clock (Africa/Nairobi — not the site's System Settings time
zone, Asia/Kolkata on kaitet.local, and not the server's UTC), and at most once
per person per EAT day (a per-user DB marker; a short Redis lock keeps two
workers from running together). Each recipient gets one email listing the Open
alerts raised or escalated (``raised_at``) since their previous digest on the
farms D4 would notify them for — recomputed here, so an alert carried silently
into a new week still reaches the digest, and one raised after today's send
goes out tomorrow. No alerts, no email. Live email sits at the free-Gmail cap,
so this is the only email the feature sends; there is never one email per alert.
"""

from datetime import timedelta

import frappe

from upande_scp.serverscripts.common import threshold_bands as B
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.reports.send_chemical_progress_email import _email_for
from upande_scp.serverscripts.scouting import spread
from upande_scp.serverscripts.scouting import thresholds_check as TC

DIGEST_HOUR = 17
DIGEST_GATE_PREFIX = "scp:alert_digest"
DIGEST_LOCK_SECONDS = 10 * 60
DIGEST_MARKER = "scp_alert_digest_on"
FIRST_DIGEST_HOURS = 24


def _candidates(now) -> dict:
    """``{user: [alert]}`` — Open alerts raised (or escalated) in the evaluation
    window up to ``now``, per D4 recipient, worst first. Not yet filtered by
    each user's last digest (``_new_for``)."""
    if not frappe.db.table_exists(TC.DOCTYPE):
        return {}
    rows = frappe.get_all(
        TC.DOCTYPE,
        filters=[
            ["status", "=", "Open"],
            ["raised_at", ">", TC.eat_stamp(now - timedelta(days=TC.EVAL_WINDOW_DAYS))],
            ["raised_at", "<=", TC.eat_stamp(now)],
        ],
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
        r["station_word"] = stations[r.crop]
        for user in TC.recipients_for(r.farm, r.crop, r.action):
            out.setdefault(user, []).append(r)
    for alerts in out.values():
        alerts.sort(key=lambda r: (
            -B.ALERT_RANK.get(r.action, 0), r.farm or "", r.warehouse or "",
            r.alert_type == B.HOT_SPOT, r.observation or "",
        ))
    return out


def _since(user, now) -> str:
    """The EAT timestamp after which ``user``'s alerts are news: their last
    digest's send time, or 24 h back for a first-ever digest. A legacy
    date-only marker counts as that day's 17:00 send."""
    marker = _marker(user)
    if len(marker) == 10:
        marker = f"{marker} {DIGEST_HOUR:02d}:00:00"
    return marker or TC.eat_stamp(now - timedelta(hours=FIRST_DIGEST_HOURS))


def _new_for(user, alerts, now) -> list:
    since = _since(user, now)
    return [a for a in alerts if a.raised_at and f"{a.raised_at:%Y-%m-%d %H:%M:%S}" > since]


def build_digests(now) -> dict:
    """``{user: [alert]}`` — each recipient's Open alerts raised or escalated
    after their last digest (D4), as ``send_alert_digest`` would send them."""
    now = now.astimezone(TC.EAT)
    out = {}
    for user, alerts in _candidates(now).items():
        mine = _new_for(user, alerts, now)
        if mine:
            out[user] = mine
    return out


def _figure(a) -> str:
    """``33.3% ± 4.1`` — or ``33.3%`` + "too clustered to judge" when the stored
    margin is meaningless (``_margin`` is the only correct reader of it); a hot
    spot shows its house's figure and its section's station count ("zones" /
    "trees") instead of a margin."""
    esc = frappe.utils.escape_html
    text = esc(B.format_value(a.value, a.unit))
    if a.get("alert_type") == B.HOT_SPOT:
        house = f"(house {esc(B.format_value(a.house_value, a.unit))}) · " if a.get("house_value") is not None else ""
        return (
            f"{text} <span style='color:#777'>{house}{int(a.sections_scouted or 0)} "
            f"{esc(B.stations_word(a.get('station_word')))} in this section</span>"
        )
    margin = TC._margin(a)
    if margin is None:
        return f"{text} <span style='color:#777'>(too clustered to judge)</span>"
    return f"{text} <span style='color:#777'>± {frappe.utils.escape_html(str(margin))}</span>"


def _patch_suffix(a, memo) -> str:
    """`` · patch of 7 zones, grew`` on a hot-spot row whose section holds part
    of a patch (spread spec C5); ``""`` otherwise, or when it cannot be read —
    the digest never fails over a patch."""
    if a.get("alert_type") != B.HOT_SPOT:
        return ""
    key = (a.crop, a.warehouse, a.kind, a.observation, a.iso_week, a.get("section_row"), a.get("section_col"))
    if key not in memo:
        try:
            memo[key] = spread.patch_note(*key)
        except Exception:
            frappe.log_error(frappe.get_traceback(), "alert digest: patch note")
            memo[key] = ""
    return f" · {frappe.utils.escape_html(memo[key])}" if memo[key] else ""


def render(alerts, day) -> str:
    """Compact HTML: one table, worst first. No emoji, no accent strips."""
    esc = frappe.utils.escape_html
    cell = "padding:4px 8px"
    notes: dict = {}
    rows = "".join(
        "<tr>"
        f"<td style='{cell}'><b>{esc(a.action)}</b></td>"
        f"<td style='{cell}'>{esc(a.warehouse)}{(' · ' + esc(a.section_label)) if a.get('section_label') else ''}"
        f"{_patch_suffix(a, notes)}</td>"
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
    hot_note = (
        " Hot spot means one part of the house is clearly worse than the house as a whole: stay alert there."
        if any(a.get("alert_type") == B.HOT_SPOT for a in alerts) else ""
    )
    return (
        "<div style='font-family:Poppins,Arial,sans-serif;font-size:13px;color:#1a1a1a'>"
        f"<p>{len(alerts)} scouting alert{plural} raised or escalated on your farms since your last "
        f"digest ({frappe.utils.formatdate(day, 'dd-MMM-yyyy')}). "
        "Scout first means the figure is unreliable: scout again before spraying."
        f"{hot_note}</p>"
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
    """One digest per person per EAT day: the marker's date part is today."""
    return _marker(user)[:10] >= day.isoformat()


def send_alert_digest(now=None) -> dict:
    """Hourly scheduler entry. From 17:00 EAT on, sends each recipient who has
    not had today's digest the Open alerts raised or escalated since their
    last one (``raised_at`` after their marker), so an alert raised at 18:30
    goes out in the next day's digest, exactly once. The marker is this run's
    EAT timestamp, a per-user DB row written only after that user's send
    succeeds: a failure is retried on the next hourly run and a cache flush
    cannot cause a second round. The Redis key is only a short concurrency
    lock around one run."""
    now = (now or TC.now_eat()).astimezone(TC.EAT)
    if now.hour < DIGEST_HOUR:
        return {"skipped": "not the send hour", "hour": now.hour}
    day = now.date()
    lock = f"{DIGEST_GATE_PREFIX}:lock"
    if not TC.take_gate(lock, DIGEST_LOCK_SECONDS):
        return {"skipped": "already running"}
    sent, failed = [], []
    try:
        for user, candidates in sorted(_candidates(now).items()):
            try:
                if _done_on(user, day):
                    continue
                alerts = _new_for(user, candidates, now)
                if not alerts:
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
                _set_marker(user, TC.eat_stamp(now))
                frappe.db.commit()
                sent.append(email)
            except Exception:
                failed.append(user)
                frappe.log_error(frappe.get_traceback(), f"scouting alert digest: {user}")
    finally:
        TC.clear_gate(lock)
    return {"sent": len(sent), "recipients": sent, "failed": failed}
