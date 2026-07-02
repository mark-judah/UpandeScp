import frappe
from frappe.utils import add_days, getdate, today


@frappe.whitelist()
def getWeeklySummary():
    """Seven-day trend used by the workspace 'Summary' tab: how pest and
    disease pressure and the scouted area (distinct beds) have moved over the
    week ending on the requested date. Mirrors the dashboard's day KPIs but as
    a time-series so the graph shows overall greenhouse-health progress."""
    try:
        end = getdate(frappe.form_dict.get("date") or today())
        start = add_days(end, -6)  # 7 days inclusive

        entries = frappe.get_all(
            "Scouting Entry",
            filters={"date_of_capture": ["between", [start, end]]},
            fields=["name", "bed", "date_of_capture"],
        )

        days = [add_days(start, i) for i in range(7)]
        labels = [d.strftime("%d %b") for d in days]
        day_index = {str(d): i for i, d in enumerate(days)}

        beds = [set() for _ in range(7)]
        name_to_day = {}
        for e in entries:
            di = day_index.get(str(e.date_of_capture))
            if di is None:
                continue
            name_to_day[e.name] = di
            if e.bed:
                beds[di].add(e.bed)

        pests = [0] * 7
        diseases = [0] * 7
        entry_names = list(name_to_day.keys())
        if entry_names:
            for p in frappe.get_all(
                "Pests Scouting Entry",
                filters={"parent": ["in", entry_names]},
                fields=["parent", "count"],
            ):
                di = name_to_day.get(p.parent)
                if di is not None:
                    pests[di] += (p.count or 1)

            for d in frappe.get_all(
                "Diseases Scouting Entry",
                filters={"parent": ["in", entry_names]},
                fields=["parent"],
            ):
                di = name_to_day.get(d.parent)
                if di is not None:
                    diseases[di] += 1

        frappe.response["message"] = {
            "labels": labels,
            "pests": pests,
            "diseases": diseases,
            "beds": [len(b) for b in beds],
            "start": str(start),
            "end": str(end),
        }

    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Weekly Summary Error")
        frappe.throw(f"Error fetching weekly summary: {str(e)}")
