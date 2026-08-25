import frappe
from frappe.utils import add_days, getdate, today

WEEKS = 6


@frappe.whitelist()
def getOverviewSummary():
    """Compact overview for the merged workspace block's 'Summary' tab — mirrors
    the /scp_app dashboard Overview: pest/disease/trap pressure bucketed into the
    last six weeks (ending on the requested date) plus range KPIs. Everything is
    grouped in SQL so six weeks of data stays cheap."""
    try:
        end = getdate(frappe.form_dict.get("date") or today())
        start = add_days(end, -(WEEKS * 7 - 1))  # 42 days inclusive → 6 buckets
        labels = [add_days(start, i * 7).strftime("%d %b") for i in range(WEEKS)]

        def weekly(table, agg):
            rows = frappe.db.sql(
                """SELECT FLOOR(DATEDIFF(se.date_of_capture, %(start)s) / 7) AS wk,
                          {agg} AS c
                   FROM `tab{table}` ch
                   JOIN `tabScouting Entry` se ON ch.parent = se.name
                   WHERE se.date_of_capture BETWEEN %(start)s AND %(end)s
                   GROUP BY wk""".format(table=table, agg=agg),
                {"start": start, "end": end},
                as_dict=True,
            )
            out = [0] * WEEKS
            for r in rows:
                w = r.get("wk")
                if w is None:
                    continue
                w = int(w)
                if 0 <= w < WEEKS:
                    out[w] += int(r.get("c") or 0)
            return out

        pests = weekly("Pests Scouting Entry", "SUM(COALESCE(ch.count, 1))")
        diseases = weekly("Diseases Scouting Entry", "COUNT(*)")
        traps = weekly("Trap Scouting Entry", "COUNT(*)")

        kpi = frappe.db.sql(
            """SELECT COUNT(DISTINCT scouts_name) AS scouts,
                      COUNT(DISTINCT greenhouse) AS greenhouses,
                      COUNT(DISTINCT bed)        AS beds,
                      COUNT(DISTINCT zone)       AS zones
               FROM `tabScouting Entry`
               WHERE date_of_capture BETWEEN %(start)s AND %(end)s""",
            {"start": start, "end": end},
            as_dict=True,
        )
        k = kpi[0] if kpi else {}

        tp, td, tt = sum(pests), sum(diseases), sum(traps)
        frappe.response["message"] = {
            "labels": labels,
            "pests": pests,
            "diseases": diseases,
            "traps": traps,
            "totals": {"pests": tp, "diseases": td, "traps": tt},
            "kpis": {
                "scouts": k.get("scouts") or 0,
                "beds": k.get("beds") or 0,
                "zones": k.get("zones") or 0,
                "greenhouses": k.get("greenhouses") or 0,
                "observations": tp + td + tt,
            },
            "start": str(start),
            "end": str(end),
        }

    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Overview Summary Error")
        frappe.throw("Error fetching overview summary: " + str(e))
