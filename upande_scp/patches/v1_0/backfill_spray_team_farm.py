"""Infer each Spray Team's farm from its Work Order history.

For every Spray Team whose ``custom_farm`` is empty:
  1. Find every Work Order that lists this team in ``custom_spray_team`` and
     has ``custom_greenhouse`` set, in the last 12 months.
  2. Resolve each greenhouse warehouse to its ``custom_farm``.
  3. If a single farm dominates (>=80% of WOs) → set ``custom_farm``.
  4. If ambiguous → write the team name + the histogram to
     ``_unassigned_spray_teams.csv`` in the bench logs dir and leave blank.

Idempotent — re-running only touches teams that are still blank.
"""
from __future__ import annotations

import csv
import os
from collections import Counter

import frappe
from frappe.utils import add_months, now_datetime


def execute() -> None:
    if not frappe.db.has_column("Spray Team", "custom_farm"):
        return

    twelve_months_ago = add_months(now_datetime(), -12)
    teams = frappe.get_all(
        "Spray Team",
        filters={"custom_farm": ["in", [None, ""]]},
        fields=["name"],
    )
    if not teams:
        return

    ambiguous: list[dict] = []
    for team in teams:
        rows = frappe.db.sql(
            """SELECT custom_greenhouse FROM `tabWork Order`
               WHERE custom_spray_team LIKE %s
                 AND custom_greenhouse IS NOT NULL
                 AND creation >= %s""",
            (f"%{team.name}%", twelve_months_ago),
            as_dict=True,
        )
        farms = Counter()
        for r in rows:
            f = frappe.db.get_value("Warehouse", r.custom_greenhouse, "custom_farm")
            if f:
                farms[f] += 1
        if not farms:
            ambiguous.append({"team": team.name, "reason": "no work-order history", "farms": {}})
            continue
        top_farm, top_count = farms.most_common(1)[0]
        total = sum(farms.values())
        if top_count / total < 0.8:
            ambiguous.append({"team": team.name, "reason": "split history", "farms": dict(farms)})
            continue
        frappe.db.set_value("Spray Team", team.name, "custom_farm", top_farm)

    if ambiguous:
        log_dir = frappe.utils.get_bench_path() + "/logs"
        os.makedirs(log_dir, exist_ok=True)
        path = os.path.join(log_dir, "_unassigned_spray_teams.csv")
        write_header = not os.path.exists(path)
        with open(path, "a", newline="") as f:
            w = csv.writer(f)
            if write_header:
                w.writerow(["team", "reason", "farms"])
            for row in ambiguous:
                w.writerow([row["team"], row["reason"], row["farms"]])

    frappe.db.commit()
