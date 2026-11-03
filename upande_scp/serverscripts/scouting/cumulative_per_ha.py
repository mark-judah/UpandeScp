"""Cumulative per-hectare pest / disease figures for block-grown crops (avocado).

An orchard block is far too large to scout in one pass, so — like a greenhouse
in a day on roses — the block is judged on what was found across its whole
scouting *round*:

    cumulative count over the round  /  the block's area in hectares

* **Round**: the ISO week, Monday to Sunday. There is no round record
  elsewhere in SCP, so the round is derived from the calendar
  (``cumulative_rules.round_bounds``).
* **Area**: ``Warehouse.custom_area_ha`` (hectares). A block without one has no
  per-ha figure; it is skipped with a logged reason, never divided by zero.
* **What is counted**: a pest's count over the *live* stages (Life stage / Form —
  a Sign such as damage is not the pest), each at its stage weight, exactly as
  the Count figure everywhere else. A disease has no count on the entry; each
  recorded observation counts once.
* **Threshold**: ``Pest Filter`` / ``Disease Filter`` ``cumulative_per_ha_threshold``
  (0 = no alert). Predators (beneficials) are not factored in yet: that would
  plug in at ``effective_threshold`` below.

``on_scouting_entry`` (doc_events on Scouting Entry) only enqueues; the job
``evaluate_block`` recomputes the block's round and sends ONE email per block x
observation x round, deduped by a ``Cumulative Pest Alert`` record whose name is
that key.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta

import frappe

from upande_scp.serverscripts.common import crop_catalog, stage_roles
from upande_scp.serverscripts.common import prevalence as P
from upande_scp.serverscripts.common import cumulative_rules as R
from upande_scp.serverscripts.reports.report_sender import report_sender
from upande_scp.serverscripts.spray_plan_creator import crop_settings

DOCTYPE = "Cumulative Pest Alert"
THRESHOLD_FIELD = "cumulative_per_ha_threshold"
LOG = "scp_cumulative_alert"


def _log(message: str) -> None:
    frappe.logger(LOG).info(message)


# ── configuration ───────────────────────────────────────────────────────────


def crop_for_block(block):
    return crop_catalog.crop_for_greenhouse(block)


def is_block_crop(crop) -> bool:
    """A crop scouted on Block warehouses — read from its houses, not its name."""
    from upande_scp.serverscripts.dashboard_aggregates import _common

    return bool(crop) and _common.station_word(crop) == "tree"


def round_days(crop=None) -> int:
    """A round is the ISO week (Monday to Sunday): fixed, not configurable."""
    return R.DEFAULT_ROUND_DAYS


def alerts_enabled(crop) -> bool:
    """On unless paused — a Check on an existing Single reads 0 until saved, so
    the switch is the pause, not the enable."""
    return not int(crop_settings.value_for("cumulative_alert_paused", crop) or 0)


def block_info(blocks) -> dict:
    """``{block: {"area_ha": float | None, "farm": str}}``."""
    if not blocks:
        return {}
    rows = frappe.get_all(
        "Warehouse",
        filters={"name": ["in", list(blocks)]},
        fields=["name", "custom_area_ha", "custom_farm"],
        limit_page_length=0,
    )
    out = {}
    for r in rows:
        area = float(r.get("custom_area_ha") or 0)
        out[r["name"]] = {"area_ha": area if area > 0 else None, "farm": r.get("custom_farm") or ""}
    return out


def thresholds(crop) -> dict:
    """``{(kind, observation): per-ha threshold}`` for the crop's filters that set one."""
    out = {}
    for kind, doctype, col in ((R.PEST, "Pest Filter", "pest"), (R.DISEASE, "Disease Filter", "disease")):
        if not frappe.db.has_column(doctype, THRESHOLD_FIELD):
            continue
        for r in frappe.get_all(
            doctype, filters={"crop_scouted": crop}, fields=[col, THRESHOLD_FIELD], limit_page_length=0
        ):
            value = float(r.get(THRESHOLD_FIELD) or 0)
            if value > 0 and r.get(col):
                out[(kind, r[col])] = value
    return out


#: Who hears about a block: users of the block's company holding one of these
#: roles. The SCP-prefixed names are current; the unprefixed ones are the legacy
#: names that may still sit on older users, so both are matched.
RECIPIENT_ROLES = (
    "SCP Spray Plan Creator", "Spray Plan Creator",
    "SCP General Manager", "General Manager",
    # Given deliberately to the people who run a farm's crop protection; unlike the
    # plain "Farm Manager" (held across every farm of a company) it means "send me
    # this". Scoped by company like the others: Employee.custom_farm is unset here.
    "SCP Farm Manager",
)
#: Plus the farm's own manager role ("Farm Manager Lokitela"), matched by name —
#: the plain "Farm Manager" role is held across every farm of a company.
FARM_MANAGER_ROLE = "Farm Manager {farm}"


def block_company(block):
    """The company of the farm the block belongs to (Warehouse.custom_farm -> Farm.company)."""
    farm = frappe.db.get_value("Warehouse", block, "custom_farm")
    return frappe.db.get_value("Farm", farm, "company") if farm else None


def recipients_for_block(block) -> list:
    """Emails of enabled users who are active Employees of the block's company
    (``Employee.company``, linked by ``user_id``) and hold a recipient role.
    Empty when the farm has no company or nobody qualifies."""
    company = block_company(block)
    if not company:
        return []
    farm = frappe.db.get_value("Warehouse", block, "custom_farm")
    roles = list(RECIPIENT_ROLES)
    farm_role = FARM_MANAGER_ROLE.format(farm=farm)
    if frappe.db.exists("Role", farm_role):
        roles.append(farm_role)
    users = frappe.get_all(
        "Employee",
        filters={"company": company, "status": "Active", "user_id": ["is", "set"]},
        pluck="user_id",
        limit_page_length=0,
    )
    if not users:
        return []
    with_role = set(frappe.get_all(
        "Has Role",
        filters={"parenttype": "User", "parent": ["in", users], "role": ["in", roles]},
        pluck="parent",
        limit_page_length=0,
    ))
    out = []
    for u in users:
        if u in with_role and u not in ("Administrator", "Guest"):
            enabled, email = frappe.db.get_value("User", u, ["enabled", "email"]) or (0, None)
            addr = (email or u or "").strip()
            if enabled and "@" in addr and addr not in out:
                out.append(addr)
    return out


def effective_threshold(crop, kind, observation, base: float) -> float:
    """The per-ha threshold in force. Today the configured figure as is; this is
    the one place a predator (beneficial) allowance would lower the pressure a
    pest has to reach before it is acted on."""
    return base


# ── figures ─────────────────────────────────────────────────────────────────


def _scout_names(ids) -> dict:
    ids = [i for i in ids if i]
    if not ids:
        return {}
    return {
        e["name"]: e.get("employee_name") or e["name"]
        for e in frappe.get_all(
            "Employee", filters={"name": ["in", ids]}, fields=["name", "employee_name"], limit_page_length=0
        )
    }


def _child_filters(alias, stage, section, params) -> str:
    """Optional stage / plant-section conditions on a child table row."""
    sql = ""
    if stage:
        sql += f" AND {alias}.stage = %(stage)s"
        params["stage"] = stage
    if section:
        sql += f" AND {alias}.plant_section = %(section)s"
        params["section"] = section
    return sql


def _round_rows(blocks, start, end, stage=None, section=None):
    """Raw ``(kind, block, observation, stage, day, scout, count)`` rows."""
    params = {"blocks": tuple(blocks), "start": start, "end": end}
    extra = _child_filters("{a}", stage, section, params)
    pests = frappe.db.sql(
        f"""
        SELECT se.block AS block, p.pest AS obs, p.stage AS stage,
               se.date_of_capture AS day, se.scouts_name AS scout, SUM(p.count) AS n
        FROM `tabPests Scouting Entry` p
        JOIN `tabScouting Entry` se ON se.name = p.parent
        WHERE se.block IN %(blocks)s AND se.date_of_capture BETWEEN %(start)s AND %(end)s
          AND p.pest IS NOT NULL AND p.pest != ''{extra.format(a="p")}
        GROUP BY se.block, p.pest, p.stage, se.date_of_capture, se.scouts_name
        """,
        params,
        as_dict=True,
    )
    diseases = frappe.db.sql(
        f"""
        SELECT se.block AS block, d.disease AS obs, '' AS stage,
               se.date_of_capture AS day, se.scouts_name AS scout, COUNT(*) AS n
        FROM `tabDiseases Scouting Entry` d
        JOIN `tabScouting Entry` se ON se.name = d.parent
        WHERE se.block IN %(blocks)s AND se.date_of_capture BETWEEN %(start)s AND %(end)s
          AND d.disease IS NOT NULL AND d.disease != ''{extra.format(a="d")}
        GROUP BY se.block, d.disease, se.date_of_capture, se.scouts_name
        """,
        params,
        as_dict=True,
    )
    return [(R.PEST, r) for r in pests] + [(R.DISEASE, r) for r in diseases]


def _scouted_blocks(blocks, start, end) -> set:
    """Blocks with any scouting entry in the round (clean ones included)."""
    if not blocks:
        return set()
    return set(frappe.db.sql_list(
        """
        SELECT DISTINCT block FROM `tabScouting Entry`
        WHERE block IN %(blocks)s AND date_of_capture BETWEEN %(start)s AND %(end)s
        """,
        {"blocks": tuple(blocks), "start": start, "end": end},
    ))


def round_figures(crop, blocks, start, end, stage=None, section=None) -> dict:
    """``{block: [figure]}`` for the round ``start..end``, every observation recorded
    on the block with its cumulative count, per-ha figure (None without an area),
    configured threshold (0 when none), day-by-day series and scouts. Worst
    per-ha first."""
    blocks = [b for b in blocks if b]
    if not blocks:
        return {}
    info = block_info(blocks)
    roles = stage_roles.role_map()
    limits = thresholds(crop)

    grouped: dict = defaultdict(lambda: {"rows": [], "scouts": set()})
    for kind, r in _round_rows(blocks, start, end, stage, section):
        if kind == R.PEST:
            if not stage_roles.is_live(r["stage"], roles):
                continue
            count = float(r["n"] or 0) * stage_roles.stage_weight(crop, r["obs"], r["stage"])
        else:
            count = float(r["n"] or 0)
        if count <= 0:
            continue
        g = grouped[(r["block"], kind, r["obs"])]
        g["rows"].append({"date": r["day"], "count": count})
        if r["scout"]:
            g["scouts"].add(r["scout"])

    names = _scout_names({s for g in grouped.values() for s in g["scouts"]})
    out: dict = {b: [] for b in blocks}
    for (block, kind, obs), g in grouped.items():
        series = R.daily_series(g["rows"])
        total = series[-1]["running"] if series else 0.0
        area = (info.get(block) or {}).get("area_ha")
        thr = effective_threshold(crop, kind, obs, limits.get((kind, obs), 0.0))
        out[block].append({
            "block": block,
            "farm": (info.get(block) or {}).get("farm") or "",
            "crop": crop,
            "kind": kind,
            "observation": obs,
            "cumulative": total,
            "area_ha": area,
            "per_ha": R.per_ha(total, area),
            "threshold_per_ha": thr,
            "crossed_on": R.crossing_day(series, area, thr),
            "daily": series,
            "scouts": sorted(names.get(s, s) for s in g["scouts"]),
            "round_start": start,
            "round_end": end,
        })
    for figs in out.values():
        figs.sort(key=lambda f: (-(f["per_ha"] or 0), f["observation"]))
    return out


def iso_label(day) -> str:
    """``2026-W42`` for the ISO week holding ``day`` (the Scouting Alert's ``iso_week``)."""
    year, week, _ = R.as_date(day).isocalendar()
    return f"{year:04d}-W{week:02d}"


def weekly_per_ha(crop, blocks, start, end, kind, observation=None, stage=None, section=None) -> list:
    """The per-ha trend, one point per ISO week with scouting in ``start..end``:
    ``[{"week", "date" (Monday), "per_ha", "cumulative", "area_ha", "blocks"}]``.

    One grouped query for the whole span (indexed by date + block). Each week is
    that week's cumulative count over the area of the blocks scouted that week
    that have an area, the same rule as the farm-wide figure. ``observation``
    narrows to one pest / disease; without it the kind's observations are added
    up. Same live-stage weighting as ``round_figures``."""
    blocks = [b for b in blocks if b]
    if not blocks:
        return []
    info = block_info(blocks)
    roles = stage_roles.role_map()
    params = {"blocks": tuple(blocks), "start": start, "end": end}
    extra = _child_filters("{a}", stage, section, params)
    if kind == R.PEST:
        obs_sql = " AND p.pest = %(obs)s" if observation else ""
        if observation:
            params["obs"] = observation
        rows = frappe.db.sql(
            f"""
            SELECT YEARWEEK(se.date_of_capture, 3) AS wk, p.pest AS obs, p.stage AS stage, SUM(p.count) AS n
            FROM `tabPests Scouting Entry` p
            JOIN `tabScouting Entry` se ON se.name = p.parent
            WHERE se.block IN %(blocks)s AND se.date_of_capture BETWEEN %(start)s AND %(end)s
              AND p.pest IS NOT NULL AND p.pest != ''{obs_sql}{extra.format(a="p")}
            GROUP BY wk, p.pest, p.stage
            """,
            params, as_dict=True,
        )
    else:
        obs_sql = " AND d.disease = %(obs)s" if observation else ""
        if observation:
            params["obs"] = observation
        rows = frappe.db.sql(
            f"""
            SELECT YEARWEEK(se.date_of_capture, 3) AS wk, d.disease AS obs, '' AS stage, COUNT(*) AS n
            FROM `tabDiseases Scouting Entry` d
            JOIN `tabScouting Entry` se ON se.name = d.parent
            WHERE se.block IN %(blocks)s AND se.date_of_capture BETWEEN %(start)s AND %(end)s
              AND d.disease IS NOT NULL AND d.disease != ''{obs_sql}{extra.format(a="d")}
            GROUP BY wk, d.disease
            """,
            params, as_dict=True,
        )
    scouted = frappe.db.sql(
        """
        SELECT DISTINCT YEARWEEK(date_of_capture, 3) AS wk, block FROM `tabScouting Entry`
        WHERE block IN %(blocks)s AND date_of_capture BETWEEN %(start)s AND %(end)s
        """,
        {"blocks": tuple(blocks), "start": start, "end": end}, as_dict=True,
    )
    area_by_week: dict = defaultdict(float)
    blocks_by_week: dict = defaultdict(int)
    for r in scouted:
        area = (info.get(r["block"]) or {}).get("area_ha")
        if area:
            area_by_week[r["wk"]] += area
            blocks_by_week[r["wk"]] += 1
    total_by_week: dict = defaultdict(float)
    for r in rows:
        if kind == R.PEST:
            if not stage_roles.is_live(r["stage"], roles):
                continue
            total_by_week[r["wk"]] += float(r["n"] or 0) * stage_roles.stage_weight(crop, r["obs"], r["stage"])
        else:
            total_by_week[r["wk"]] += float(r["n"] or 0)
    out = []
    for wk in sorted(set(area_by_week) | set(total_by_week)):
        label = P.yearweek_label(wk)
        if not label:
            continue
        out.append({
            "week": label, "date": P.week_monday(label),
            "per_ha": R.per_ha(total_by_week.get(wk, 0.0), area_by_week.get(wk)),
            "cumulative": total_by_week.get(wk, 0.0),
            "area_ha": round(area_by_week.get(wk, 0.0), 2), "blocks": blocks_by_week.get(wk, 0),
        })
    return out


def alert_findings(crop, today=None) -> list:
    """Scouting Alert findings for a block-grown crop, judged per hectare: for
    every block, its latest scouted ISO week of the last two (this week, else
    last week) and every observation recorded that week that has a
    ``cumulative_per_ha_threshold``. At or over the line is High; a block without
    an area, or an observation without a line, yields nothing (no figure is
    invented). Same dict shape as ``thresholds_check.evaluate``."""
    from upande_scp.serverscripts.common import threshold_bands as B

    today = R.as_date(today or frappe.utils.nowdate())
    limits = thresholds(crop)
    if not limits:
        return []
    blocks = crop_catalog.greenhouses_for_crop(crop)
    weeks = [R.round_bounds(today - timedelta(days=7 * i), round_days(crop)) for i in (0, 1)]
    scouted = [_scouted_blocks(blocks, a, b) for a, b in weeks]
    out = []
    figs = {}
    for i, (a, b) in enumerate(weeks):
        if scouted[i]:
            figs[i] = round_figures(crop, sorted(scouted[i]), a, b)
    station = "tree"
    for blk in blocks:
        i = next((i for i in (0, 1) if blk in scouted[i]), None)
        if i is None:
            continue
        a, _b = weeks[i]
        previous = iso_label(weeks[i + 1][0]) if i == 0 and blk in scouted[1] else None
        for f in figs[i].get(blk, []):
            thr = f["threshold_per_ha"]
            if f["per_ha"] is None or not thr:
                continue
            over = f["per_ha"] >= thr
            out.append({
                "crop": crop, "warehouse": blk, "kind": f["kind"], "observation": f["observation"],
                "stage": "", "iso_week": iso_label(a), "previous_week": previous,
                "alert_type": B.HOUSE, "section_row": -1, "section_col": -1, "section_label": "",
                "measure": B.PER_HA, "station_word": station, "unit": B.unit_label(B.PER_HA, station),
                "value": f["per_ha"], "threshold": thr, "margin": None, "reliability": "Good",
                "sections_scouted": 0, "sections_total": 0,
                "band": "high" if over else "",
                "action": B.SPRAY_ADVISED if over else None,
            })
    return out


# ── the alert ───────────────────────────────────────────────────────────────


def _alerted(block, kind, observation, round_start) -> bool:
    return bool(frappe.db.exists(DOCTYPE, R.alert_key(block, kind, observation, round_start)))


def evaluate_block(block, day=None) -> dict:
    """Recompute ``block``'s round holding ``day`` (default today) and email each
    observation that has newly passed its per-ha threshold. Returns what it did,
    including why it skipped. Safe to call repeatedly."""
    crop = crop_for_block(block)
    if not crop or not is_block_crop(crop):
        return {"skipped": "not a block-grown crop", "block": block}
    if not alerts_enabled(crop):
        return {"skipped": "cumulative alerts are off", "block": block, "crop": crop}
    day = R.as_date(day or frappe.utils.nowdate())
    start, end = R.round_bounds(day, round_days(crop))
    area = (block_info([block]).get(block) or {}).get("area_ha")
    if not area:
        _log(f"skip {block}: no area (Warehouse.custom_area_ha) — cannot compute per-ha")
        return {"skipped": "block has no area", "block": block, "crop": crop}
    if end < R.as_date(frappe.utils.nowdate()) - timedelta(days=round_days(crop)):
        _log(f"skip {block}: round {start}..{end} is over — a late sync does not alert")
        return {"skipped": "round is over", "block": block, "round_start": str(start)}

    sent, passed = [], []
    for fig in round_figures(crop, [block], start, end).get(block, []):
        if not R.should_alert(fig["per_ha"], fig["threshold_per_ha"], _alerted(block, fig["kind"], fig["observation"], start)):
            continue
        passed.append(fig["observation"])
        result = send_alert(fig)
        if result.get("sent"):
            sent.append(fig["observation"])
    return {"block": block, "crop": crop, "round_start": str(start), "round_end": str(end),
            "passed": passed, "sent": sent}


def send_alert(fig, *, only_to=None) -> dict:
    """Record and email one crossing. ``only_to`` sends a test to that address
    alone, writing no dedupe record."""
    recipients = [only_to] if only_to else recipients_for_block(fig["block"])
    if not recipients:
        _log(f"skip {fig['block']} / {fig['observation']}: no recipients (no enabled {block_company(fig['block'])} user with a spray-plan creator or manager role)")
        return {"sent": False, "reason": "no recipients"}
    from upande_scp.serverscripts.reports.cumulative_alert_email import render, subject

    name = None
    if not only_to:
        doc = frappe.get_doc({
            "doctype": DOCTYPE,
            "crop": fig["crop"], "farm": fig["farm"] or None, "warehouse": fig["block"],
            "kind": fig["kind"], "observation": fig["observation"],
            "round_start": fig["round_start"], "round_end": fig["round_end"],
            "cumulative": fig["cumulative"], "area_ha": fig["area_ha"], "per_ha": fig["per_ha"],
            "threshold_per_ha": fig["threshold_per_ha"], "crossed_on": fig["crossed_on"],
            "days": frappe.as_json([{"date": str(d["date"]), "count": d["count"]} for d in fig["daily"]]),
            "scouts": ", ".join(fig["scouts"]),
            "status": "Sent", "emailed_at": frappe.utils.now_datetime(),
            "recipients": ", ".join(recipients),
        })
        try:
            doc.insert(ignore_permissions=True)
        except frappe.DuplicateEntryError:
            return {"sent": False, "reason": "already alerted this round"}
        name = doc.name
    try:
        frappe.sendmail(
            recipients=recipients,
            subject=subject(fig, test=bool(only_to)),
            message=render(fig, test=bool(only_to)),
            reference_doctype=DOCTYPE if name else None,
            reference_name=name,
            sender=report_sender(block_company(fig["block"])),
        )
    except Exception:
        # Nothing went out: drop the record so the next entry tries again.
        if name:
            frappe.delete_doc(DOCTYPE, name, ignore_permissions=True, force=True)
        frappe.log_error(frappe.get_traceback(), f"cumulative alert email: {fig['block']} / {fig['observation']}")
        return {"sent": False, "reason": "send failed"}
    frappe.db.commit()
    return {"sent": True, "name": name, "recipients": recipients}


# ── hook ────────────────────────────────────────────────────────────────────


def on_scouting_entry(doc, method=None) -> None:
    """doc_events on Scouting Entry (on_update). Never slows or breaks a save: it
    only checks the entry is a block entry and queues the recompute, one queued
    job per block at a time."""
    try:
        block = (doc.get("block") or "").strip()
        if not block or doc.get("greenhouse"):
            return
        frappe.enqueue(
            "upande_scp.serverscripts.scouting.cumulative_per_ha.evaluate_block",
            queue="short",
            job_id=f"scp-cumulative-{frappe.local.site}-{block}",
            deduplicate=True,
            enqueue_after_commit=True,
            block=block,
            day=str(doc.get("date_of_capture") or ""),
        )
    except Exception:
        frappe.log_error(frappe.get_traceback(), "cumulative alert: enqueue")


# ── endpoints ───────────────────────────────────────────────────────────────


def _assert_crop(crop):
    from upande_scp.serverscripts.common import crop_scope

    crop_scope.assert_crop(crop)
    if not is_block_crop(crop):
        frappe.throw(f"{crop} is not scouted by block, so it has no per-hectare figure.")


def farm_summary(blocks, figs, scouted, area_of) -> list:
    """Farm-wide figure per observation: total count over the area of every block
    scouted this round that has an area, so a block walked clean dilutes it and a
    block without an area adds neither numerator nor denominator. Each row also
    names the worst block and how many blocks are over their threshold."""
    scouted_area = sum(area_of.get(b) or 0 for b in scouted)
    agg: dict = {}
    for b in blocks:
        for f in figs.get(b, []):
            if f["area_ha"] is None:
                continue
            a = agg.setdefault(
                (f["kind"], f["observation"]),
                {"count": 0.0, "blocks": 0, "over": 0, "worst": None, "threshold": f["threshold_per_ha"]},
            )
            a["count"] += f["cumulative"]
            a["blocks"] += 1
            if f["threshold_per_ha"] and (f["per_ha"] or 0) >= f["threshold_per_ha"]:
                a["over"] += 1
            if a["worst"] is None or (f["per_ha"] or 0) > a["worst"]["per_ha"]:
                a["worst"] = {"block": b, "per_ha": f["per_ha"]}
    summary = [
        {
            "kind": kind, "observation": obs, "cumulative": a["count"], "area_ha": round(scouted_area, 2),
            "per_ha": R.per_ha(a["count"], scouted_area), "blocks": a["blocks"], "worst": a["worst"],
            "threshold_per_ha": a["threshold"], "blocks_over": a["over"],
        }
        for (kind, obs), a in agg.items()
    ]
    summary.sort(key=lambda s: (-(s["per_ha"] or 0), s["observation"]))
    return summary


@frappe.whitelist()
def get_round_per_ha(crop="Avocado", farm=None, block=None, day=None) -> dict:
    """The current round's cumulative per-ha figures for a crop's blocks (all the
    farm's blocks, or one): ``{"round": {...}, "blocks": [{block, farm, area_ha,
    observations: [...]}], "farm_per_ha": {kind|observation: {...}}}``."""
    from upande_scp.serverscripts.common import crop_scope

    _assert_crop(crop)
    day = R.as_date(day or frappe.utils.nowdate())
    days = round_days(crop)
    start, end = R.round_bounds(day, days)

    houses = crop_catalog.greenhouses_for_crop(crop)
    info = block_info(houses)
    scoped = crop_scope.scoped_farms(crop, frappe.session.user)
    blocks = [
        b for b in houses
        if (not block or b == block)
        and (not farm or info.get(b, {}).get("farm") == farm)
        and (scoped is None or info.get(b, {}).get("farm") in scoped)
    ]
    figs = round_figures(crop, blocks, start, end)

    scouted = _scouted_blocks(blocks, start, end)
    area_of = {b: info.get(b, {}).get("area_ha") for b in blocks}
    summary = farm_summary(blocks, figs, scouted, area_of)
    out_blocks = [
        {
            "block": b,
            "farm": info.get(b, {}).get("farm", ""),
            "area_ha": area_of[b],
            "scouted": b in scouted,
            "observations": [
                {k: (str(v) if k in ("round_start", "round_end") else v) for k, v in f.items() if k != "daily"}
                | {"daily": [{"date": str(d["date"]), "count": d["count"], "running": d["running"]} for d in f["daily"]]}
                for f in figs.get(b, [])
            ],
        }
        for b in blocks
    ]
    return {
        "crop": crop,
        "round": {"start": str(start), "end": str(end), "days": days, "label": _round_label(start, end, days)},
        "blocks": out_blocks,
        "summary": summary,
        "no_area": [b["block"] for b in out_blocks if not b["area_ha"]],
    }


def _round_label(start, end, days) -> str:
    return f"{start:%d %b} to {end:%d %b}" + (" (week)" if days == 7 else f" ({days} days)")


def _may_trigger():
    roles = set(frappe.get_roles(frappe.session.user))
    if not roles & {"SCP General Manager", "System Manager", "Administrator"}:
        frappe.throw("Not permitted.", frappe.PermissionError)


def _sample_figure(crop, block=None):
    """A figure to preview: the block's (or the farm's) highest per-ha one this round."""
    _assert_crop(crop)
    start, end = R.round_bounds(frappe.utils.nowdate(), round_days(crop))
    blocks = [block] if block else crop_catalog.greenhouses_for_crop(crop)
    best = None
    for fs in round_figures(crop, blocks, start, end).values():
        for f in fs:
            if f["per_ha"] is not None and (best is None or f["per_ha"] > best["per_ha"]):
                best = f
    if best is None:
        frappe.throw("No avocado scouting with a block area was found in the current round to build a sample from.")
    if not best["threshold_per_ha"]:
        # Nothing configured yet: show the sample against a threshold just under
        # the figure so the layout is complete.
        best = {**best, "threshold_per_ha": max(round(best["per_ha"] * 0.8, 1), 0.1), "illustrative_threshold": True}
    return best


@frappe.whitelist()
def preview_cumulative_alert_email(crop="Avocado", block=None) -> str:
    """The alert email's HTML for the block's strongest observation this round,
    without sending — for the Reports page preview."""
    _may_trigger()
    from upande_scp.serverscripts.reports.cumulative_alert_email import render

    return render(_sample_figure(crop, block), test=True)


@frappe.whitelist()
def send_test_cumulative_alert(crop="Avocado", block=None) -> dict:
    """Send the preview to the signed-in user only (never the report group)."""
    _may_trigger()
    user = frappe.session.user
    email = frappe.db.get_value("User", user, "email") or user
    if "@" not in (email or ""):
        frappe.throw("Your user has no email address to send the test to.")
    result = send_alert(_sample_figure(crop, block), only_to=email)
    return {**result, "to": email}


def check_now(crop="Avocado") -> dict:
    """Console helper: evaluate every block of the crop for today."""
    return {b: evaluate_block(b) for b in crop_catalog.greenhouses_for_crop(crop)}
