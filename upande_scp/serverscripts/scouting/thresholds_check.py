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
week's alert (and older weeks' only when it is Fair/Good or its week is over,
so a thin Monday sample cannot clear last week's alert), and a live Converted
alert is never touched (one whose plan died reopens). After each crop's
findings, ``sweep`` resolves alerts no check will reach again (key no longer
banded, or week older than the window).

A **hot spot** (spec 2026-10-10-hot-spots) is a section of the 3 x 3 grid whose
band is above the house's, at least Moderate, with >= 5 scouted stations. It is
its own alert per (house, observation, stage, week, section), stay-alert only,
sent to the Alarming audience, and re-announced only when its band rises.

``run_threshold_check`` (hourly) is gated by a Redis ``SET NX EX``: one run per
50 minutes across workers. The 17:00 EAT digest (``alert_digest``) is the only
email.
"""

import hashlib
from datetime import date, datetime, timedelta
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
    "alert_type", "section_row", "section_col", "section_label",
    "measure", "value", "margin", "reliability", "sections_scouted", "sections_total",
    "band", "action", "status", "raised_on", "raised_at", "acknowledged_by", "work_order",
]
#: Every key-based statement matches the alert type and section too, so a house
#: alert and a hot spot on the same (house, observation, stage, week) never
#: resolve, supersede or carry each other (hot-spots spec §2).
_KEY_SQL = (
    "warehouse = %(wh)s AND kind = %(kind)s AND observation = %(obs)s "
    "AND COALESCE(stage, '') = %(stage)s AND COALESCE(alert_type, 'House') = %(type)s "
    "AND section_row = %(row)s AND section_col = %(col)s"
)


def now_eat() -> datetime:
    """Now on the farms' clock (Africa/Nairobi), whatever the site's System
    Settings time zone (Asia/Kolkata on kaitet.local) or the server (UTC) say."""
    return datetime.now(EAT)


def eat_stamp(moment) -> str:
    """``moment`` on the farms' clock as a naive ``YYYY-MM-DD HH:MM:SS`` — how
    ``raised_at`` and the digest marker are stored (EAT, like ``raised_on``)."""
    return moment.astimezone(EAT).strftime("%Y-%m-%d %H:%M:%S")


def alert_name(warehouse, kind, observation, stage, iso_week,
               alert_type=B.HOUSE, section_row=-1, section_col=-1) -> str:
    """A Scouting Alert's name: its unique key, hashed (spec §4). A House key
    hashes exactly as before hot spots (no existing alert is renamed); a hot
    spot's key adds its type and section."""
    parts = [warehouse or "", kind or "", observation or "", stage or "", iso_week or ""]
    if alert_type == B.HOT_SPOT:
        parts += [B.HOT_SPOT, str(int(section_row)), str(int(section_col))]
    key = "|".join(parts)
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
    every banded key: the house finding (``alert_type`` House), then one
    hot-spot finding per section with a figure (``_section_findings``). A
    finding with ``action`` None resolves rather than raises: a house below
    Moderate ("" or "low"), or a section that does not meet hot-spots H2."""
    crop = crop_catalog.canonical(crop)
    keys = sorted(_common.load_thresholds(crop)) if crop else []
    if not keys:
        return []
    today = today or now_eat().date()
    from_date = (today - timedelta(days=EVAL_WINDOW_DAYS - 1)).isoformat()
    kinds = tuple(sorted({kind for kind, _obs, _stage in keys}))
    weeks = R.StationWeeks.load(from_date, today.isoformat(), crop, None, kinds=kinds, lookback_days=0)
    station = _common.station_word(crop)
    unit_word = B.section_unit(station)
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
            house = {
                "crop": crop, "warehouse": wh, "kind": kind, "observation": obs,
                "stage": stage, "iso_week": week, "previous_week": previous,
                "alert_type": B.HOUSE, "section_row": -1, "section_col": -1, "section_label": "",
                "measure": spec["measure"],
                "unit": B.unit_label(spec["measure"], station), "value": value,
                "margin": fig.get("margin"), "reliability": fig.get("reliability") or "Low",
                "sections_scouted": fig.get("sections_scouted") or 0,
                "sections_total": fig.get("sections_total") or P.SECTIONS,
                "band": band, "action": B.action_for(band, fig.get("reliability")),
            }
            out.append(house)
            out.extend(_section_findings(house, fig, spec, unit_word))
    return out


def _section_findings(house, fig, spec, unit_word) -> list:
    """Hot-spots H2 for each section of the house's figure, in the row's
    measure (section ``pct`` for a Percentage, ``avg`` for a Count): no extra
    query. A section that meets H2 raises ``Hot spot``. Every other section
    with a figure is a clear reading (action None) that resolves its hot spot:
    this week's always, older weeks' only when the section is Fair/Good
    (n ≥ 5) or its week is over (3a's thin-sample rule, H6). A section without
    a figure (< 3 stations scouted) yields nothing."""
    out = []
    for r in B.section_readings(house["value"], fig.get("sections"), spec, spec["measure"]):
        out.append({
            **house,
            "alert_type": B.HOT_SPOT, "section_row": r["row"], "section_col": r["col"],
            "section_label": B.section_label(r["row"], r["col"], unit_word),
            "house_value": house["value"], "value": r["value"], "margin": None,
            "reliability": r["reliability"], "sections_scouted": r["scouted"], "sections_total": 1,
            "band": r["band"], "action": B.HOT_SPOT if r["hot"] else None,
        })
    return out


# ── alerts ─────────────────────────────────────────────────────────────────


def _key_params(finding) -> dict:
    hot = finding.get("alert_type") == B.HOT_SPOT
    return {
        "wh": finding["warehouse"], "kind": KIND_LABEL[finding["kind"]],
        "obs": finding["observation"], "stage": finding["stage"] or "",
        "week": finding["iso_week"],
        "type": B.HOT_SPOT if hot else B.HOUSE,
        "row": int(finding["section_row"]) if hot else -1,
        "col": int(finding["section_col"]) if hot else -1,
    }


def _name_for(params) -> str:
    return alert_name(params["wh"], params["kind"], params["obs"], params["stage"], params["week"],
                      params["type"], params["row"], params["col"])


def finding_key(finding) -> tuple:
    """A finding's alert key without its week:
    (house, kind label, observation, stage, type, row, col)."""
    p = _key_params(finding)
    return (p["wh"], p["kind"], p["obs"], p["stage"], p["type"], p["row"], p["col"])


def _row_key(row) -> tuple:
    """``finding_key`` for a stored Scouting Alert row."""
    hot = (row.get("alert_type") or B.HOUSE) == B.HOT_SPOT
    return (
        row.get("warehouse"), row.get("kind"), row.get("observation"), row.get("stage") or "",
        B.HOT_SPOT if hot else B.HOUSE,
        int(row.get("section_row")) if hot else -1, int(row.get("section_col")) if hot else -1,
    )


def _existing(name, latest=False):
    """The alert's state, or None. ``latest`` takes a locking read: after losing
    an insert race, a plain read under REPEATABLE READ still answers from this
    transaction's snapshot and would not see the winner's committed row."""
    if not latest:
        return frappe.db.get_value(
            DOCTYPE, name, ["name", "status", "notified_action", "notified_band", "notified", "work_order"], as_dict=True,
        )
    rows = frappe.db.sql(
        """SELECT name, status, notified_action, notified_band, notified, work_order FROM `tabScouting Alert`
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
        f"""SELECT name, notified_action, notified_band, status, work_order FROM `tabScouting Alert`
            WHERE {_KEY_SQL} AND iso_week = %(prev)s AND status IN %(live)s
            LIMIT 1""",
        {**params, "prev": previous_week, "live": LIVE_STATES},
        as_dict=True,
    )
    if not rows:
        return None
    row = rows[0]
    if row.status == "Converted to plan" and plan_is_dead(row.work_order):
        return None   # its plan is gone: the breach is nobody's, so not carried
    return row


def _resolve(params, include_week: bool, older: bool = True) -> None:
    """Resolve the key's Open / Acknowledged alerts of earlier weeks (when
    ``older``) and of this week (when ``include_week``). Converted alerts are
    left alone."""
    if include_week and older:
        op = "<="
    elif older:
        op = "<"
    elif include_week:
        op = "="
    else:
        return
    frappe.db.sql(
        f"""UPDATE `tabScouting Alert` SET status = 'Resolved', modified = %(now)s
            WHERE {_KEY_SQL} AND iso_week {op} %(week)s AND status IN %(open)s""",
        {**params, "open": OPEN_STATES, "now": frappe.utils.now()},
    )


RELIABLE = ("Good", "Fair")


def _week_ended(iso_week, today) -> bool:
    """True once the ISO week's Sunday is behind ``today`` (EAT)."""
    try:
        year, week = iso_week.split("-W")
        return date.fromisocalendar(int(year), int(week), 7) < today
    except (ValueError, AttributeError):
        return False


def _clean_may_supersede(finding, now) -> bool:
    """A below-Moderate figure may resolve OLDER weeks' alerts only when it can
    be trusted: reliability Fair/Good, or its ISO week is over. A thin Monday
    sample (one clean section) only clears its own week, so last week's alert
    stays live and is carried when the week fills (D5) instead of being
    resolved and re-announced."""
    return finding.get("reliability") in RELIABLE or _week_ended(finding["iso_week"], now.date())


def upsert(finding, now=None, _retry=True):
    """Write one finding. Returns the alert's name, or None for a finding with
    no action (a house below Moderate, a section no longer meeting H2), which
    resolves the key's open alerts up to its week. A house alert escalates by
    its action (D5); a hot spot by its section's band, Moderate → High
    (hot-spots H5). The two never share a key (``_key_params``)."""
    now = now or now_eat()
    params = _key_params(finding)
    hot = params["type"] == B.HOT_SPOT
    action = finding["action"]
    if not action:
        _resolve(params, include_week=True, older=_clean_may_supersede(finding, now))
        return None

    name = _name_for(params)
    band = B.BAND_LABEL[finding["band"]]
    fields = {
        # ``margin`` is a NOT NULL Float: a clustered figure (m < 2, margin
        # None) or a hot spot (one section, no margin) is stored as 0 and read
        # back as None by ``_margin``.
        "measure": finding["measure"], "value": finding["value"], "margin": finding["margin"] or 0,
        "reliability": finding["reliability"], "sections_scouted": finding["sections_scouted"],
        "sections_total": finding["sections_total"], "band": band, "action": action,
    }
    level, level_field = (band, "notified_band") if hot else (action, "notified_action")
    existing = _existing(name, latest=not _retry)
    reopened = False
    if existing and existing.status == "Converted to plan":
        if not plan_is_dead(existing.work_order):
            # A live curative plan owns this alert: never overwrite or re-notify it.
            return name
        # Its plan was deleted, cancelled, stopped (auto-cancel / rejection) or
        # closed: the breach is nobody's again. Reopen it; escalation rules
        # below decide whether anyone is told.
        frappe.db.set_value(DOCTYPE, name, {"status": "Open", "work_order": None})
        existing.status = "Open"
        reopened = True
    if existing:
        frappe.db.set_value(DOCTYPE, name, fields)
        already, status = existing.get(level_field), existing.status
    else:
        previous = _previous_live(params, finding.get("previous_week"))
        doc = frappe.get_doc({
            "doctype": DOCTYPE, "crop": finding["crop"],
            "farm": frappe.db.get_value("Warehouse", params["wh"], "custom_farm"),
            "warehouse": params["wh"], "kind": params["kind"], "observation": params["obs"],
            "stage": params["stage"], "iso_week": params["week"],
            "alert_type": params["type"], "section_row": params["row"], "section_col": params["col"],
            "section_label": finding.get("section_label") or "",
            **fields,
            "status": "Open", "raised_on": now.date(), "raised_at": eat_stamp(now),
            # Carried across weeks: the same action (house) or band (hot spot)
            # again is not news (D5, H5).
            level_field: previous.get(level_field) if previous else None,
        })
        try:
            doc.insert(ignore_permissions=True)
        except frappe.DuplicateEntryError:
            # Another run inserted this key first and owns its notification:
            # re-read the winner (locking read) and carry on from its state.
            if not _retry:
                return name
            return upsert(finding, now, _retry=False)
        already, status = doc.get(level_field), "Open"
        existing = frappe._dict(notified="")

    updates = {}
    if reopened:
        # A live breach lost its plan: land in the next digest.
        updates.update(raised_on=now.date(), raised_at=eat_stamp(now))
    if status == "Resolved":
        # This week's figure dropped out and came back.
        updates.update(status="Open", raised_on=now.date(), raised_at=eat_stamp(now))
    escalated = B.band_escalates(already, level) if hot else B.escalates(already, level)
    if escalated:
        updates.update({level_field: level, "raised_on": now.date(), "raised_at": eat_stamp(now)})
        if status == "Acknowledged":
            updates["status"] = "Open"
        sent = _notify(name, finding, action, PLAN_GONE if reopened else "")
        if sent:
            told = set(filter(None, (existing.notified or "").split("\n"))) | set(sent)
            updates["notified"] = "\n".join(sorted(told))
    elif reopened:
        # Same action as already announced, but the plan is gone: say so.
        sent = _notify(name, finding, action, PLAN_GONE)
        if sent:
            told = set(filter(None, (existing.notified or "").split("\n"))) | set(sent)
            updates["notified"] = "\n".join(sorted(told))
    if updates:
        frappe.db.set_value(DOCTYPE, name, updates)
    _resolve(params, include_week=False)   # a newer week supersedes older alerts
    return name


PLAN_GONE = "The linked plan was cancelled, stopped or removed, so this breach has no plan again."


def _notify(name, finding, action, note="") -> list:
    """In-app only (category "scouting"). Returns who was told. A recipient
    failure is logged and never blocks the alert."""
    try:
        farm = frappe.db.get_value("Warehouse", finding["warehouse"], "custom_farm")
        users = recipients_for(farm, finding["crop"], action)
    except Exception:
        frappe.log_error(frappe.get_traceback(), "threshold check: recipients")
        return []
    if finding.get("alert_type") == B.HOT_SPOT:
        subject, body = _hot_spot_text(finding)
    else:
        stage = f" · {finding['stage']}" if finding["stage"] else ""
        value = B.format_value(finding["value"], finding["unit"])
        tail = " — the figure is unreliable, scout again before spraying" if action == B.SCOUT_FIRST else ""
        subject = (
            f"{action}: {finding['observation']}{stage} {value} in {finding['warehouse']} "
            f"({finding['iso_week']}){tail}"
        )
        margin = f"±{finding['margin']}" if finding["margin"] is not None else "too clustered to judge"
        body = (
            f"{note + ' ' if note else ''}{subject}. {finding['crop']} · {margin} · "
            f"{finding['sections_scouted']}/{finding['sections_total']} sections scouted · "
            f"reliability {finding['reliability']}."
        )
    return notifications.notify(
        users, subject, body, DOCTYPE, name, category="scouting",
        link=dashboard_link(finding["crop"]),
    )


def _hot_spot_text(finding) -> tuple:
    """Hot-spots §3: "Hot spot in <house>, <section>: Thrips 45% (house 12%) —
    high infestation in this area, stay alert". No spray advice (H3)."""
    stage = f" · {finding['stage']}" if finding["stage"] else ""
    value = B.format_value(finding["value"], finding["unit"])
    house = B.format_value(finding.get("house_value"), finding["unit"])
    subject = (
        f"Hot spot in {finding['warehouse']}, {finding['section_label']}: {finding['observation']}{stage} "
        f"{value} (house {house}) — high infestation in this area, stay alert"
    )
    body = (
        f"{subject}. {finding['crop']} · {finding['iso_week']} · {finding['sections_scouted']} stations "
        f"scouted in this section · band {B.BAND_LABEL.get(finding['band'], '')} · "
        "spraying follows the house's own alert."
    )
    return subject, body


def dashboard_link(crop) -> str:
    """The crop's Overview in the SCP app, where its open alerts are listed. The
    slug mirrors the frontend's ``cropSlug`` ("Passion Fruit" → "passion-fruit");
    a full path, so the Desk bell's href lands there too."""
    slug = "-".join((crop or "rose").strip().lower().split()) or "rose"
    return f"{APP_PATH}#/{slug}/dashboard"


DEAD_PLAN_STATUSES = ("Cancelled", "Stopped", "Closed")


def plan_is_dead(work_order) -> bool:
    """True when a Converted alert's curative plan no longer owns it: the Work
    Order is gone (a deleted draft), cancelled, or Stopped / Closed (the
    auto-cancel and the approver's rejection both stop it)."""
    if not work_order:
        return True
    row = frappe.db.get_value("Work Order", work_order, ["docstatus", "status"], as_dict=True)
    return not row or row.docstatus == 2 or row.status in DEAD_PLAN_STATUSES


def reopen_for_plan(work_order) -> int:
    """Give a deleted plan's Converted alerts back to the Overview (Open, no
    plan). Called before a draft plan is deleted; the hourly check catches a
    plan that is cancelled or stopped (``plan_is_dead``)."""
    if not work_order or not frappe.db.table_exists(DOCTYPE):
        return 0
    names = frappe.get_all(
        DOCTYPE, filters={"work_order": work_order, "status": "Converted to plan"}, pluck="name",
    )
    now = now_eat()
    for name in names:
        # Silent (the creator knows) but it lands in the next digest.
        frappe.db.set_value(DOCTYPE, name, {
            "status": "Open", "work_order": None, "raised_on": now.date(), "raised_at": eat_stamp(now),
        })
    return len(names)


def sweep(crop, today=None, latest=None, actionable=None) -> int:
    """Resolve the crop's Open / Acknowledged alerts that no check will ever
    touch again: their key is no longer banded, or their ISO week ended before
    the evaluation window (a house no longer scouted). Converted alerts are
    left to their plan, unless that plan is dead: such an alert is reopened only
    when its week is still its house's latest week (``latest``: warehouse → ISO
    week) AND its key's latest finding still has an action (``actionable``:
    ``finding_key``s) — else resolved, because a breach that has since cleared
    is nobody's to plan. Both come from this run's findings; either missing is
    derived from ``evaluate``. Returns how many were resolved."""
    crop = crop_catalog.canonical(crop) or crop
    if not crop:
        return 0
    today = today or now_eat().date()
    window_start = today - timedelta(days=EVAL_WINDOW_DAYS - 1)
    banded = {(KIND_LABEL[k], obs, stage or "") for k, obs, stage in _common.load_thresholds(crop)}
    rows = frappe.get_all(
        DOCTYPE, filters={"crop": crop, "status": ["in", list(OPEN_STATES)]},
        fields=["name", "kind", "observation", "stage", "iso_week"], limit_page_length=0,
    )
    stale = [
        r.name for r in rows
        if (r.kind, r.observation, r.stage or "") not in banded or _week_ended(r.iso_week, window_start)
    ]
    for name in stale:
        frappe.db.set_value(DOCTYPE, name, "status", "Resolved")
    if latest is None or actionable is None:
        findings = evaluate(crop, today)
        if latest is None:
            latest = {f["warehouse"]: f["iso_week"] for f in findings}
        if actionable is None:
            actionable = {finding_key(f) for f in findings if f["action"]}
    now = now_eat()
    orphans = frappe.get_all(
        DOCTYPE, filters={"crop": crop, "status": "Converted to plan"},
        fields=["name", "warehouse", "kind", "observation", "stage", "iso_week", "work_order",
                "alert_type", "section_row", "section_col"],
        limit_page_length=0,
    )
    for r in orphans:
        if not plan_is_dead(r.work_order):
            continue
        if latest.get(r.warehouse) == r.iso_week and _row_key(r) in actionable:
            frappe.db.set_value(DOCTYPE, r.name, {
                "status": "Open", "work_order": None,
                "raised_on": now.date(), "raised_at": eat_stamp(now),
            })
        else:
            frappe.db.set_value(DOCTYPE, r.name, "status", "Resolved")
            stale.append(r.name)
    return len(stale)


def _live_hotspot_keys(crop) -> set:
    """``finding_key``s (week-less) of the crop's Open / Acknowledged hot spots:
    a clear section reading only matters where one is live."""
    rows = frappe.get_all(
        DOCTYPE, filters={"crop": crop, "alert_type": B.HOT_SPOT, "status": ["in", list(OPEN_STATES)]},
        fields=["warehouse", "kind", "observation", "stage", "alert_type", "section_row", "section_col"],
        limit_page_length=0,
    )
    return {_row_key(r) for r in rows}


def check_crop(crop, today=None) -> dict:
    findings = evaluate(crop, today)
    # Up to nine clear section readings per key per house: write only the ones
    # that can resolve something, so the hourly run issues no blind UPDATEs.
    live = _live_hotspot_keys(crop_catalog.canonical(crop) or crop)
    todo = [f for f in findings
            if f["alert_type"] == B.HOUSE or f["action"] or finding_key(f) in live]
    alerts = [n for n in (upsert(f) for f in todo) if n]
    latest = {f["warehouse"]: f["iso_week"] for f in findings}
    actionable = {finding_key(f) for f in findings if f["action"]}
    return {"findings": len(findings), "alerts": len(alerts), "swept": sweep(crop, today, latest, actionable)}


def _crops_to_check() -> list:
    """Banded crops, plus any crop still holding Open / Acknowledged alerts (its
    bands may all have been cleared: the sweep must still resolve them)."""
    with_alerts = frappe.get_all(
        DOCTYPE, filters={"status": ["in", list(OPEN_STATES)]}, pluck="crop", distinct=True,
    )
    return sorted(set(banded_crops()) | {c for c in with_alerts if c})


def run_threshold_check(today=None, force=False, commit=True) -> dict:
    """Hourly scheduler entry (hooks.py). One run per 50 minutes across workers;
    each crop commits on its own so one failing crop never loses the others."""
    if not force and not take_gate(CHECK_GATE_KEY, CHECK_GATE_SECONDS):
        return {"skipped": "ran less than 50 minutes ago"}
    if not frappe.db.table_exists(DOCTYPE):
        return {"skipped": "no Scouting Alert doctype"}
    _common.clear_threshold_cache()
    out = {"crops": {}, "errors": []}
    for crop in _crops_to_check():
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
    """D4. Alarming and Hot spot → the farm's Spray Plan Creators + Spray Supervisors, or its
    crop-scoped GMs when both rosters are empty (somebody must hear). Spray
    advised / Scout first → those + the farm's Spray Plan Approvers + the
    crop-scoped SCP General Managers."""
    base = _roster("Farm Spray Plan Creator", farm) + _roster("Farm Spray Supervisor", farm)
    if action in (B.ALARMING, B.HOT_SPOT):
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
    rows = frappe.get_all(DOCTYPE, filters=filters, fields=ALERT_FIELDS, 
                          limit_page_length=0)   # no cap: it would cut before the severity sort
    station = _common.station_word(crop)
    for r in rows:
        r["unit"] = B.unit_label(r.measure, station)
        r["margin"] = _margin(r)
    rows.sort(key=lambda r: (
        -B.ACTION_RANK.get(r.action, 0), r.status != "Open", -(r.value or 0),
        r.warehouse or "", r.observation or "", r.stage or "",
    ))
    return rows


# ── figures for the block report and the Jobsheet (D8) ────────────────────


def figures_for_houses(crop, houses, from_date, to_date) -> dict:
    """``{house: {pest: figure}}`` — each house's latest scouted ISO week in the
    window, every pest recorded that week, judged exactly as the alerts judge
    it (same measure, figure and row bands). ``band`` is None when the pest has
    no usable bands."""
    crop = crop_catalog.canonical(crop)
    houses = sorted({h for h in (houses or ()) if h})
    if not crop or not houses:
        return {}
    weeks = R.StationWeeks.load(from_date, to_date, crop, houses, kinds=("pest",), lookback_days=0)
    station = _common.station_word(crop)
    out = {}
    for wh in weeks.warehouses():
        week, _previous = weeks.latest_pair(wh)
        per = {}
        for obs in weeks.observations(wh, week, "pest"):
            spec = _common.band_spec(crop, "pest", obs, "")
            measure = spec["measure"] if spec else B.PERCENTAGE
            fig, value = _figure(weeks, wh, week, "pest", obs, "", spec or {"measure": B.PERCENTAGE})
            fig = fig or {}
            band = B.band_of(value, spec["low"], spec["mod"], spec["high"]) if spec else None
            per[obs] = {
                "measure": measure, "unit": B.unit_label(measure, station), "value": value,
                "margin": fig.get("margin"), "reliability": fig.get("reliability") or "Low",
                "sections_scouted": fig.get("sections_scouted") or 0,
                "sections_total": fig.get("sections_total") or P.SECTIONS,
                "band": band, "action": B.action_for(band, fig.get("reliability")), "week": week,
            }
        out[wh] = per
    return out


@frappe.whitelist()
def house_figures(crop: str, warehouse: str, from_date: str, to_date: str) -> dict:
    """The Jobsheet's per-pest figures for one block or greenhouse."""
    crop = crop_catalog.resolve_crop(crop)
    if not crop or not warehouse:
        return {}
    _assert_can_see(crop, frappe.db.get_value("Warehouse", warehouse, "custom_farm"))
    return figures_for_houses(crop, [warehouse], from_date, to_date).get(warehouse, {})


# ── the spray plan creator (D7) ────────────────────────────────────────────

CREATOR_ACTIONS = (B.SPRAY_ADVISED, B.SCOUT_FIRST)


def creator_alerts(warehouses) -> dict:
    """``{warehouse: [alert]}`` — Open / Acknowledged Spray advised and Scout
    first alerts on these houses, worst first: the creator's badges."""
    houses = sorted({w for w in (warehouses or ()) if w})
    if not houses or not frappe.db.table_exists(DOCTYPE):
        return {}
    rows = frappe.get_all(
        DOCTYPE,
        filters={
            "warehouse": ["in", houses],
            "status": ["in", list(OPEN_STATES)],
            "action": ["in", list(CREATOR_ACTIONS)],
        },
        fields=ALERT_FIELDS,
        limit_page_length=0,
    )
    stations: dict = {}
    out: dict = {}
    for r in rows:
        if r.crop not in stations:
            stations[r.crop] = _common.station_word(r.crop)
        r["unit"] = B.unit_label(r.measure, stations[r.crop])
        r["margin"] = _margin(r)
        out.setdefault(r.warehouse, []).append(r)
    for alerts in out.values():
        alerts.sort(key=lambda r: (-B.ACTION_RANK.get(r.action, 0), r.observation or "", r.stage or ""))
    return out


def assert_alert_for_plan(alert, greenhouse, targets=None):
    """R15: the checks that must pass BEFORE a plan is inserted from ``alert`` —
    it exists, is Open/Acknowledged, is for this greenhouse and its crop, and
    the caller may see it, and (when ``targets`` is given) the plan treats its
    observation. Returns the alert row."""
    row = frappe.db.get_value(
        DOCTYPE, alert, ["name", "crop", "farm", "warehouse", "status", "work_order"], as_dict=True,
    )
    if not row:
        frappe.throw(f"Scouting alert {alert} does not exist.", frappe.ValidationError)
    if row.warehouse != greenhouse:
        frappe.throw(f"Scouting alert {alert} is for {row.warehouse}, not {greenhouse}.", frappe.ValidationError)
    if row.status not in OPEN_STATES:
        frappe.throw(
            f"Scouting alert {alert} is {row.status}; only an Open or Acknowledged alert can start a plan.",
            frappe.ValidationError,
        )
    plan_crop = crop_catalog.crop_for_greenhouse(greenhouse)
    if plan_crop and plan_crop != row.crop:
        frappe.throw(f"Scouting alert {alert} is for {row.crop}, not {plan_crop}.", frappe.ValidationError)
    _assert_can_see(row.crop, row.farm)
    if targets is not None:
        observation = frappe.db.get_value(DOCTYPE, alert, "observation")
        wanted = {(t.get("target") if isinstance(t, dict) else t) for t in targets}
        if observation not in wanted:
            frappe.throw(
                f"Scouting alert {alert} is for {observation}, which this plan does not target.",
                frappe.ValidationError,
            )
    return row


def convert_to_plan(alert, work_order, greenhouse):
    """Link the curative plan saved from ``alert`` and mark it Converted (D7).
    Refuses a bad alert (``assert_alert_for_plan``); an already-converted alert
    keeps its first plan."""
    row = frappe.db.get_value(DOCTYPE, alert, ["name", "warehouse", "status", "work_order"], as_dict=True)
    if row and row.warehouse == greenhouse and row.status == "Converted to plan" and row.work_order:
        return row.work_order
    assert_alert_for_plan(alert, greenhouse)
    frappe.db.set_value(DOCTYPE, alert, {"status": "Converted to plan", "work_order": work_order})
    return work_order
