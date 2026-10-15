"""Spray interventions between scouting weeks, with the result the next week showed.

Feeds the 3D heatmap's playback: for ONE greenhouse (and one pest/disease, or all
of them), every pair of consecutive scouted weeks becomes an *interval*. An
intervention belongs to the interval it falls in, and the interval carries the
prevalence before and after — the existing prevalence figures (``common.prevalence``,
including its Good/Fair/Low reliability), not a new metric.

An intervention is a spray plan (Application Floor Plan Work Order) that was
manufactured or completed: it has a submitted Manufacture Stock Entry, or sits in
a post-manufacture workflow state. Its date is the Manufacture entry, else the
tank-mix issue (``Stock Entry.custom_spray_plan``), else the planned date.
"""

import frappe
from frappe.utils import add_days

from upande_scp.serverscripts.common import crop_catalog
from upande_scp.serverscripts.dashboard_aggregates._common import (
    cached_aggregate,
    parent_filter_conditions,
)
from upande_scp.serverscripts.dashboard_aggregates._prevalence_rows import (
    ANY,
    WINDOW,
    StationWeeks,
)
from upande_scp.serverscripts.dashboard_aggregates._trends import week_key

AFP = "Application Floor Plan"
#: Workflow states that mean the tank mix was made (or the spray done).
DONE_STATES = ("Tank Mix Manufactured", "Spraying In Progress", "Completed")
_KIND = ("pest", "disease")


def _split_targets(raw) -> list:
    return [t.strip() for t in (raw or "").replace("\r", "").split("\n") if t.strip()]


def targets_include(targets, obs_name: str) -> bool:
    """True when the plan targets ``obs_name`` (case-insensitive); an empty
    ``obs_name`` means "all targets" and matches every plan."""
    if not (obs_name or "").strip():
        return True
    want = obs_name.strip().lower()
    return any(t.strip().lower() == want for t in targets or ())


def fetch_interventions(greenhouse: str, from_date: str, to_date: str) -> list:
    """Manufactured/completed spray plans for ``greenhouse`` dated in range."""
    if not greenhouse:
        return []
    wos = frappe.db.sql(
        """
        SELECT wo.name, wo.workflow_state AS state, wo.custom_targets AS targets,
               wo.custom_spray_type AS spray_type,
               DATE(wo.planned_start_date) AS planned
        FROM `tabWork Order` wo
        WHERE wo.docstatus = 1 AND wo.custom_type = %(afp)s
          AND wo.custom_greenhouse = %(gh)s
          AND DATE(wo.planned_start_date) BETWEEN %(f)s AND %(t)s
        """,
        {"afp": AFP, "gh": greenhouse,
         "f": add_days(from_date, -60), "t": add_days(to_date, 30)},
        as_dict=True,
    )
    if not wos:
        return []
    names = [w.name for w in wos]
    made, issued = {}, {}
    for r in frappe.db.sql(
        """SELECT work_order AS wo, MIN(posting_date) AS d FROM `tabStock Entry`
           WHERE docstatus = 1 AND purpose = 'Manufacture' AND work_order IN %(n)s
           GROUP BY work_order""", {"n": names}, as_dict=True):
        made[r.wo] = str(r.d)
    if frappe.get_meta("Stock Entry").has_field("custom_spray_plan"):
        for r in frappe.db.sql(
            """SELECT custom_spray_plan AS wo, MIN(posting_date) AS d FROM `tabStock Entry`
               WHERE docstatus = 1 AND custom_spray_plan IN %(n)s
               GROUP BY custom_spray_plan""", {"n": names}, as_dict=True):
            issued[r.wo] = str(r.d)

    items = {}
    for r in frappe.db.sql(
        """SELECT woi.parent AS wo, woi.item_code AS item, i.item_name AS chemical
           FROM `tabWork Order Item` woi JOIN `tabItem` i ON i.name = woi.item_code
           WHERE woi.parent IN %(n)s""", {"n": names}, as_dict=True):
        items.setdefault(r.wo, {})[r.item] = r.chemical
    ai = {}
    codes = {}
    all_items = {i for d in items.values() for i in d}
    if all_items and frappe.db.exists("DocType", "Spray Product"):
        for r in frappe.db.sql(
            """SELECT c.item AS item, a.ingredient AS ingredient
               FROM `tabSpray Product` c JOIN `tabActive Ingredient` a
                 ON a.parent = c.name AND a.parenttype = 'Spray Product'
               WHERE c.item IN %(i)s""", {"i": tuple(all_items)}, as_dict=True):
            if r.ingredient:
                ai.setdefault(r.item, set()).add(r.ingredient)
        from upande_scp.serverscripts.common import crop_protection as cp
        for it in all_items:
            try:
                got = []
                for kind in ("frac", "irac"):
                    got += [f"{kind.upper()} {c}" for c in cp.get_product_codes(it, kind)]
                codes[it] = got
            except Exception:
                codes[it] = []

    out = []
    for w in wos:
        state_ok = w.state in DONE_STATES
        date = made.get(w.name) or issued.get(w.name)
        if not (state_ok or w.name in made):
            continue
        date = date or str(w.planned)
        if not (str(from_date) <= date <= str(to_date)):
            continue
        its = items.get(w.name, {})
        out.append({
            "workOrder": w.name,
            "date": date,
            "plannedDate": str(w.planned),
            "sprayType": (w.spray_type or "").strip(),
            "chemicals": sorted(set(its.values())),
            "ingredients": sorted({a for i in its for a in ai.get(i, ())}),
            "moa": sorted({c for i in its for c in codes.get(i, ())}),
            "targets": _split_targets(w.targets),
        })
    out.sort(key=lambda e: (e["date"], e["workOrder"]))
    return out


def scouting_by_week(greenhouse: str, from_date: str, to_date: str, crop: str = "") -> dict:
    """``{week: {first, last, entries, scouts}}`` — session date bounds (to place
    an intervention before/after a week's scouting) and the sample size."""
    where = ["se.greenhouse = %(gh)s", "se.date_of_capture BETWEEN %(f)s AND %(t)s"]
    params = {"gh": greenhouse, "f": from_date, "t": to_date}
    if crop:
        where.append(crop_catalog.entry_crop_condition("se"))
        params.update(crop_catalog.crop_sql_params(crop))
    rows = frappe.db.sql(
        f"""SELECT se.date_of_capture AS d, COUNT(*) AS n,
                   GROUP_CONCAT(DISTINCT se.scouts_name) AS scouts
            FROM `tabScouting Entry` se WHERE {' AND '.join(where)}
            GROUP BY se.date_of_capture""", params, as_dict=True)
    out: dict = {}
    for r in rows:
        wk = week_key(r.d)
        if not wk:
            continue
        b = out.setdefault(wk, {"first": str(r.d), "last": str(r.d), "entries": 0, "_s": set()})
        b["first"] = min(b["first"], str(r.d))
        b["last"] = max(b["last"], str(r.d))
        b["entries"] += int(r.n or 0)
        b["_s"] |= {s for s in (r.scouts or "").split(",") if s}
    for b in out.values():
        b["scouts"] = len(b.pop("_s"))
    return out


def figure_summary(fig) -> dict | None:
    """The prevalence figure's public fields for one week, or None if unscouted."""
    if not fig:
        return None
    return {k: fig.get(k) for k in (
        "prevalence", "margin", "reliability", "coverage", "scouted", "infested",
        "stations", "sections_scouted", "sections_total", "reason")}


def delta_between(before, after) -> dict:
    """Change in prevalence, in percentage points, with a direction word.

    Lower prevalence is better. Within 1 point is "unchanged": the figures carry
    a margin of error, so a smaller move is noise."""
    b = (before or {}).get("prevalence")
    a = (after or {}).get("prevalence")
    if b is None or a is None:
        return {"delta": None, "direction": "unknown"}
    d = round(a - b, 1)
    direction = "unchanged" if abs(d) < 1 else ("better" if d < 0 else "worse")
    return {"delta": d, "direction": direction}


def week_accuracy(weeks: list, figs: dict, scouting: dict) -> dict:
    """Per scouted week: the prevalence figure's reliability plus the sample size
    (entries, scouts), so playback shows data quality without per-week requests."""
    out = {}
    for w in weeks:
        f = figs.get(w) or {}
        s = scouting.get(w) or {}
        out[w] = {
            "reliability": f.get("reliability"), "prevalence": f.get("prevalence"),
            "margin": f.get("margin"), "coverage": f.get("coverage"),
            "entries": s.get("entries"), "scouts": s.get("scouts"),
        }
    return out


def build_intervals(weeks: list, scouting: dict, events: list, figs: dict,
                    obs_name: str = "") -> list:
    """Pure assembly. ``weeks`` ascending scouted week labels; ``figs[week]`` a
    figure summary; every consecutive pair is one interval, kept only when at
    least one matching intervention falls in ``(last scouting of A, first of B]``."""
    out = []
    for a, b in zip(weeks, weeks[1:]):
        lo = (scouting.get(a) or {}).get("last")
        hi = (scouting.get(b) or {}).get("first")
        if not lo or not hi:
            continue
        hits = [e for e in events
                if lo < e["date"] <= hi and targets_include(e["targets"], obs_name)]
        if not hits:
            continue
        before, after = figs.get(a), figs.get(b)
        out.append({
            "fromWeek": a, "toWeek": b,
            "interventions": hits,
            "before": before, "after": after,
            **delta_between(before, after),
            "quality": {
                "before": {k: (scouting.get(a) or {}).get(k) for k in ("entries", "scouts")},
                "after": {k: (scouting.get(b) or {}).get(k) for k in ("entries", "scouts")},
            },
        })
    return out


def heatmap_interventions(args: dict, force: bool = False) -> dict:
    greenhouse = (args.get("greenhouse") or "").strip()
    obs_name = (args.get("obs_name") or "").strip()
    obs_kind = (args.get("obs_kind") or "pest").strip()
    if not greenhouse or obs_kind not in _KIND:
        return {"intervals": []}
    filters = {
        "from_date": args.get("from_date", ""), "to_date": args.get("to_date", ""),
        "crop": (args.get("crop") or "").strip(), "greenhouse": greenhouse,
        "obs_name": obs_name, "obs_kind": obs_kind,
    }

    def build():
        rows = StationWeeks.load(
            filters["from_date"], filters["to_date"], filters["crop"], [greenhouse],
            kinds=(obs_kind,), weeks=WINDOW,
        )
        weeks = rows.weeks(greenhouse)
        figs = {w: figure_summary(rows.figures(
            greenhouse, w, obs_kind, obs=obs_name or ANY)) for w in weeks}
        scouting = scouting_by_week(
            greenhouse, filters["from_date"], filters["to_date"], filters["crop"])
        events = fetch_interventions(greenhouse, filters["from_date"], filters["to_date"])
        return {"greenhouse": greenhouse, "obsName": obs_name, "obsKind": obs_kind,
                "weeks": week_accuracy(weeks, figs, scouting),
                "intervals": build_intervals(weeks, scouting, events, figs, obs_name)}

    return cached_aggregate("heatmap_interventions", filters, build, force=force)
