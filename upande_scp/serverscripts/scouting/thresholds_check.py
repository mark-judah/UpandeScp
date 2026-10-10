"""Thresholds → actions → Scouting Alerts (spec 2026-10-10 §3–§5, D3–D6).

For each crop with usable bands, ``evaluate`` reads every house scouted in its
latest ISO week (window: the last 14 days to today, Africa/Nairobi) and judges
each banded (kind, observation, stage) in its measure: the adjusted prevalence
for a Percentage, the average count per scouted station for a Count (piece 2's
StationWeeks, so piece 1's crop scoping holds).

``upsert`` keeps one **Scouting Alert** per (house, kind, observation, stage,
ISO week). The alert's name IS that key, so a concurrent second insert fails
instead of duplicating, and the loser re-reads without notifying. A
notification (in-app, category "scouting", never email) goes out only when the
action escalates over the highest action already raised (D5). Within a week
that is this alert's own ``notified_action``. Across weeks it is the house's
live alert of its immediately previous scouted week (only), so a consecutive
week at the same action is recorded silently. A newer week supersedes older
Open / Acknowledged alerts (Resolved), a figure below Moderate resolves its
week's alert, and a Converted alert is never touched.

``run_threshold_check`` (hourly) is gated by a Redis ``SET NX EX``: one run per
50 minutes across workers. The 17:00 EAT digest (``alert_digest``) is the only
email.
"""

import hashlib
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import frappe

from upande_scp.serverscripts.common import crop_catalog, crop_scope, notifications
from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.common import threshold_bands as B
from upande_scp.serverscripts.dashboard_aggregates import _common
from upande_scp.serverscripts.dashboard_aggregates import _prevalence_rows as R

EAT = ZoneInfo("Africa/Nairobi")
DOCTYPE = "Scouting Alert"
EVAL_WINDOW_DAYS = 14
CHECK_GATE_KEY = "scp:threshold_check:gate"
CHECK_GATE_SECONDS = 50 * 60
GM_ROLE = "SCP General Manager"
APP_PATH = "/scp_app"
KIND_LABEL = {"pest": "Pest", "disease": "Disease"}
OPEN_STATES = ("Open", "Acknowledged")
LIVE_STATES = ("Open", "Acknowledged", "Converted to plan")
ALERT_FIELDS = [
    "name", "crop", "farm", "warehouse", "kind", "observation", "stage", "iso_week",
    "measure", "value", "margin", "reliability", "sections_scouted", "sections_total",
    "band", "action", "status", "raised_on", "acknowledged_by", "work_order",
]
_KEY_SQL = (
    "warehouse = %(wh)s AND kind = %(kind)s AND observation = %(obs)s "
    "AND COALESCE(stage, '') = %(stage)s"
)


def now_eat() -> datetime:
    """Now on the farms' clock (Africa/Nairobi), whatever the site's System
    Settings time zone (Asia/Kolkata on kaitet.local) or the server (UTC) say."""
    return datetime.now(EAT)


def alert_name(warehouse, kind, observation, stage, iso_week) -> str:
    """A Scouting Alert's name: its unique key, hashed (spec §4)."""
    key = "|".join([warehouse or "", kind or "", observation or "", stage or "", iso_week or ""])
    return f"SA-{iso_week}-{hashlib.sha1(key.encode()).hexdigest()[:10]}"


def take_gate(key, seconds) -> bool:
    """True for the first caller in ``seconds``; atomic across workers."""
    cache = frappe.cache()
    return bool(cache.set(cache.make_key(key), 1, ex=int(seconds), nx=True))


def clear_gate(key) -> None:
    frappe.cache().delete_value(key)


# ── evaluation ─────────────────────────────────────────────────────────────


def banded_crops() -> list:
    """Crops with at least one usable band."""
    return [c for c in crop_catalog.catalog().get("crops", []) if _common.load_thresholds(c)]


def _figure(weeks, wh, week, kind, obs, stage, spec):
    """(figure, value) for one key, in its measure."""
    if spec["measure"] == B.COUNT:
        fig = weeks.count_figures(wh, week, kind, obs, stages=spec["count_stages"])
        return fig, (fig or {}).get("value")
    fig = weeks.figures(wh, week, kind, obs, stage or R.ANY)
    return fig, (fig or {}).get("prevalence")


def evaluate(crop, today=None) -> list:
    """Findings for every house scouted in its latest ISO week of the window ×
    every banded key. ``band`` "" (below Low) or "low" carries ``action`` None —
    those findings resolve alerts rather than raise them."""
    crop = crop_catalog.canonical(crop)
    keys = sorted(_common.load_thresholds(crop)) if crop else []
    if not keys:
        return []
    today = today or now_eat().date()
    from_date = (today - timedelta(days=EVAL_WINDOW_DAYS - 1)).isoformat()
    kinds = tuple(sorted({kind for kind, _obs, _stage in keys}))
    weeks = R.StationWeeks.load(from_date, today.isoformat(), crop, None, kinds=kinds, lookback_days=0)
    station = _common.station_word(crop)
    out = []
    for wh in weeks.warehouses():
        week, previous = weeks.latest_pair(wh)
        if not week:
            continue
        for kind, obs, stage in keys:
            spec = _common.band_spec(crop, kind, obs, stage)
            if not spec:
                continue
            fig, value = _figure(weeks, wh, week, kind, obs, stage, spec)
            if value is None:
                continue
            band = B.band_of(value, spec["low"], spec["mod"], spec["high"])
            out.append({
                "crop": crop, "warehouse": wh, "kind": kind, "observation": obs,
                "stage": stage, "iso_week": week, "previous_week": previous,
                "measure": spec["measure"],
                "unit": B.unit_label(spec["measure"], station), "value": value,
                "margin": fig.get("margin"), "reliability": fig.get("reliability") or "Low",
                "sections_scouted": fig.get("sections_scouted") or 0,
                "sections_total": fig.get("sections_total") or P.SECTIONS,
                "band": band, "action": B.action_for(band, fig.get("reliability")),
            })
    return out


# ── alerts ─────────────────────────────────────────────────────────────────


def _key_params(finding) -> dict:
    return {
        "wh": finding["warehouse"], "kind": KIND_LABEL[finding["kind"]],
        "obs": finding["observation"], "stage": finding["stage"] or "",
        "week": finding["iso_week"],
    }


def _existing(name, latest=False):
    """The alert's state, or None. ``latest`` takes a locking read: after losing
    an insert race, a plain read under REPEATABLE READ still answers from this
    transaction's snapshot and would not see the winner's committed row."""
    if not latest:
        return frappe.db.get_value(
            DOCTYPE, name, ["name", "status", "notified_action", "notified"], as_dict=True,
        )
    rows = frappe.db.sql(
        """SELECT name, status, notified_action, notified FROM `tabScouting Alert`
           WHERE name = %s FOR UPDATE""",
        (name,), as_dict=True,
    )
    return rows[0] if rows else None


def _previous_live(params, previous_week):
    """The key's live alert of the house's IMMEDIATELY previous scouted week —
    the only one whose action is carried (D5). An older alert (a Converted one,
    or an Open one on a house that went unscouted) never silences a recurrence:
    a clean or missing week in between means the new alert is news."""
    if not previous_week:
        return None
    rows = frappe.db.sql(
        f"""SELECT name, notified_action FROM `tabScouting Alert`
            WHERE {_KEY_SQL} AND iso_week = %(prev)s AND status IN %(live)s
            LIMIT 1""",
        {**params, "prev": previous_week, "live": LIVE_STATES},
        as_dict=True,
    )
    return rows[0] if rows else None


def _resolve(params, include_week: bool) -> None:
    """Resolve the key's Open / Acknowledged alerts of earlier weeks (and of
    this week when ``include_week``). Converted alerts are left alone."""
    op = "<=" if include_week else "<"
    frappe.db.sql(
        f"""UPDATE `tabScouting Alert` SET status = 'Resolved', modified = %(now)s
            WHERE {_KEY_SQL} AND iso_week {op} %(week)s AND status IN %(open)s""",
        {**params, "open": OPEN_STATES, "now": frappe.utils.now()},
    )


def upsert(finding, now=None, _retry=True):
    """Write one finding. Returns the alert's name, or None for a finding below
    Moderate (which resolves the key's open alerts up to its week)."""
    now = now or now_eat()
    params = _key_params(finding)
    action = finding["action"]
    if not action:
        _resolve(params, include_week=True)
        return None

    name = alert_name(params["wh"], params["kind"], params["obs"], params["stage"], params["week"])
    fields = {
        # ``margin`` is a NOT NULL Float: a clustered figure (m < 2, margin
        # None) is stored as 0 and read back as None by ``_margin``.
        "measure": finding["measure"], "value": finding["value"], "margin": finding["margin"] or 0,
        "reliability": finding["reliability"], "sections_scouted": finding["sections_scouted"],
        "sections_total": finding["sections_total"], "band": B.BAND_LABEL[finding["band"]],
        "action": action,
    }
    existing = _existing(name, latest=not _retry)
    if existing and existing.status == "Converted to plan":
        # A curative plan owns this alert: never overwrite or re-notify it.
        return name
    if existing:
        frappe.db.set_value(DOCTYPE, name, fields)
        already, status = existing.notified_action, existing.status
    else:
        previous = _previous_live(params, finding.get("previous_week"))
        doc = frappe.get_doc({
            "doctype": DOCTYPE, "crop": finding["crop"],
            "farm": frappe.db.get_value("Warehouse", params["wh"], "custom_farm"),
            "warehouse": params["wh"], "kind": params["kind"], "observation": params["obs"],
            "stage": params["stage"], "iso_week": params["week"], **fields,
            "status": "Open", "raised_on": now.date(),
            # Carried across weeks: the same action again is not news (D5).
            "notified_action": previous.notified_action if previous else None,
        })
        try:
            doc.insert(ignore_permissions=True)
        except frappe.DuplicateEntryError:
            # Another run inserted this key first and owns its notification:
            # re-read the winner (locking read) and carry on from its state.
            if not _retry:
                return name
            return upsert(finding, now, _retry=False)
        already, status = doc.notified_action, "Open"
        existing = frappe._dict(notified="")

    updates = {}
    if status == "Resolved":
        # This week's figure dropped below Moderate and came back.
        updates.update(status="Open", raised_on=now.date())
    if B.escalates(already, action):
        updates.update(notified_action=action, raised_on=now.date())
        if status == "Acknowledged":
            updates["status"] = "Open"
        sent = _notify(name, finding, action)
        if sent:
            told = set(filter(None, (existing.notified or "").split("\n"))) | set(sent)
            updates["notified"] = "\n".join(sorted(told))
    if updates:
        frappe.db.set_value(DOCTYPE, name, updates)
    _resolve(params, include_week=False)   # a newer week supersedes older alerts
    return name


def _notify(name, finding, action) -> list:
    """In-app only (category "scouting"). Returns who was told. A recipient
    failure is logged and never blocks the alert."""
    try:
        farm = frappe.db.get_value("Warehouse", finding["warehouse"], "custom_farm")
        users = recipients_for(farm, finding["crop"], action)
    except Exception:
        frappe.log_error(frappe.get_traceback(), "threshold check: recipients")
        return []
    stage = f" · {finding['stage']}" if finding["stage"] else ""
    value = B.format_value(finding["value"], finding["unit"])
    tail = " — the figure is unreliable, scout again before spraying" if action == B.SCOUT_FIRST else ""
    subject = (
        f"{action}: {finding['observation']}{stage} {value} in {finding['warehouse']} "
        f"({finding['iso_week']}){tail}"
    )
    margin = f"±{finding['margin']}" if finding["margin"] is not None else "too clustered to judge"
    body = (
        f"{subject}. {finding['crop']} · {margin} · "
        f"{finding['sections_scouted']}/{finding['sections_total']} sections scouted · "
        f"reliability {finding['reliability']}."
    )
    return notifications.notify(
        users, subject, body, DOCTYPE, name, category="scouting",
        link=dashboard_link(finding["crop"]),
    )


def dashboard_link(crop) -> str:
    """The crop's Overview in the SCP app, where its open alerts are listed. The
    slug mirrors the frontend's ``cropSlug`` ("Passion Fruit" → "passion-fruit");
    a full path, so the Desk bell's href lands there too."""
    slug = "-".join((crop or "rose").strip().lower().split()) or "rose"
    return f"{APP_PATH}#/{slug}/dashboard"


def check_crop(crop, today=None) -> dict:
    findings = evaluate(crop, today)
    alerts = [n for n in (upsert(f) for f in findings) if n]
    return {"findings": len(findings), "alerts": len(alerts)}


def run_threshold_check(today=None, force=False, commit=True) -> dict:
    """Hourly scheduler entry (hooks.py). One run per 50 minutes across workers;
    each crop commits on its own so one failing crop never loses the others."""
    if not force and not take_gate(CHECK_GATE_KEY, CHECK_GATE_SECONDS):
        return {"skipped": "ran less than 50 minutes ago"}
    if not frappe.db.table_exists(DOCTYPE):
        return {"skipped": "no Scouting Alert doctype"}
    _common.clear_threshold_cache()
    out = {"crops": {}, "errors": []}
    for crop in banded_crops():
        try:
            out["crops"][crop] = check_crop(crop, today)
            if commit:
                frappe.db.commit()
        except Exception:
            if commit:
                frappe.db.rollback()
            frappe.log_error(frappe.get_traceback(), f"threshold check: {crop}")
            out["errors"].append(crop)
    return out


# ── recipients (D4) ────────────────────────────────────────────────────────


def _roster(child, farm) -> list:
    if not farm or not frappe.db.table_exists(child):
        return []
    return frappe.get_all(child, filters={"parent": farm, "parenttype": "Farm"}, pluck="user")


def _gms(farm, crop) -> list:
    """SCP General Managers whose crop scope covers this farm."""
    out = []
    for user in notifications.users_for_role(GM_ROLE):
        farms = crop_scope.scoped_farms(crop, user)
        if farms is None or farm in farms:
            out.append(user)
    return out


def recipients_for(farm, crop, action) -> list:
    """D4. Alarming → the farm's Spray Plan Creators + Spray Supervisors, or its
    crop-scoped GMs when both rosters are empty (somebody must hear). Spray
    advised / Scout first → those + the farm's Spray Plan Approvers + the
    crop-scoped SCP General Managers."""
    base = _roster("Farm Spray Plan Creator", farm) + _roster("Farm Spray Supervisor", farm)
    if action == B.ALARMING:
        users = base or _gms(farm, crop)
    else:
        users = base + _roster("Farm Spray Plan Approver", farm) + _gms(farm, crop)
    return notifications._clean(users)


# ── endpoints ──────────────────────────────────────────────────────────────


def _assert_can_see(crop, farm) -> None:
    crop_scope.assert_crop(crop)
    farms = crop_scope.scoped_farms(crop)
    if farms is not None and farm not in farms:
        frappe.throw(f"{farm} is not a farm you have access to for {crop}.", frappe.PermissionError)


def _may_acknowledge(row, user) -> bool:
    """R5: the alert's recipients (D4, for its current action — plus anyone it
    already told), an SCP General Manager who may see its crop and farm, or a
    System Manager."""
    roles = set(frappe.get_roles(user))
    if "System Manager" in roles:
        return True
    if user in set(filter(None, (row.notified or "").split("\n"))):
        return True
    if user in recipients_for(row.farm, row.crop, row.action):
        return True
    if GM_ROLE in roles:
        try:
            _assert_can_see(row.crop, row.farm)
            return True
        except frappe.PermissionError:
            return False
    return False


@frappe.whitelist()
def acknowledge_alert(name: str) -> dict:
    """Mark an Open alert seen (recorded with who and when). Refused, with a
    PermissionError, to anyone ``_may_acknowledge`` does not admit."""
    row = frappe.db.get_value(
        DOCTYPE, name, ["name", "crop", "farm", "status", "action", "notified"], as_dict=True,
    )
    if not row:
        frappe.throw(f"Scouting alert {name} does not exist.", frappe.DoesNotExistError)
    user = frappe.session.user
    if not _may_acknowledge(row, user):
        frappe.throw(
            "Only the people this alert was raised for, or an SCP General Manager, may acknowledge it.",
            frappe.PermissionError,
        )
    if row.status != "Open":
        return {"name": name, "status": row.status}
    frappe.db.set_value(DOCTYPE, name, {
        "status": "Acknowledged",
        "acknowledged_by": user,
        "acknowledged_on": frappe.utils.now_datetime(),
    })
    return {"name": name, "status": "Acknowledged"}


def _margin(row):
    """The stored margin, or None when fewer than two sections counted — the
    one case the figure has none ("too clustered to judge"); see ``upsert``."""
    return None if (row.get("sections_scouted") or 0) < 2 else row.get("margin")


@frappe.whitelist()
def open_alerts(crop: str, farm: str | None = None, greenhouse: str | None = None) -> list:
    """Open + Acknowledged alerts of one crop on the farms the user may see,
    worst action first. Uncached: Acknowledge must show at once."""
    crop = crop_catalog.resolve_crop(crop)
    if not crop or not frappe.db.table_exists(DOCTYPE):
        return []
    crop_scope.assert_crop(crop)
    farms = crop_scope.scoped_farms(crop)
    filters = {"crop": crop, "status": ["in", list(OPEN_STATES)]}
    if farm:
        if farms is not None and farm not in farms:
            return []
        filters["farm"] = farm
    elif farms is not None:
        if not farms:
            return []
        filters["farm"] = ["in", sorted(farms)]
    if greenhouse:
        filters["warehouse"] = greenhouse
    rows = frappe.get_all(DOCTYPE, filters=filters, fields=ALERT_FIELDS, limit_page_length=500)
    station = _common.station_word(crop)
    for r in rows:
        r["unit"] = B.unit_label(r.measure, station)
        r["margin"] = _margin(r)
    rows.sort(key=lambda r: (
        -B.ACTION_RANK.get(r.action, 0), r.status != "Open", -(r.value or 0),
        r.warehouse or "", r.observation or "", r.stage or "",
    ))
    return rows
