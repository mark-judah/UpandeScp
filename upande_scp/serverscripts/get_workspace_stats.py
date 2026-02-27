import frappe
from frappe.utils import today

@frappe.whitelist()
def getWorkspaceStats():
    try:
        date_str = frappe.form_dict.get("date") or today()

        entries = frappe.get_all(
            "Scouting Entry",
            filters={"date_of_capture": date_str},
            fields=["name", "scouts_name", "bed", "zone", "greenhouse"]
        )

        total_entries = len(entries)
        scouts_active = len({e.scouts_name for e in entries if e.scouts_name})
        beds_scouted = len({e.bed for e in entries if e.bed})
        zones_scouted = len({e.zone for e in entries if e.zone})
        greenhouses_scouted = len({e.greenhouse for e in entries if e.greenhouse})

        top_pest = None
        top_disease = None

        if entries:
            entry_names = [e.name for e in entries]

            # Top pest by count
            pest_records = frappe.get_all(
                "Pests Scouting Entry",
                filters={"parent": ["in", entry_names]},
                fields=["pest", "count"]
            )
            pest_totals = {}
            for p in pest_records:
                if p.pest:
                    pest_totals[p.pest] = pest_totals.get(p.pest, 0) + (p.count or 1)
            if pest_totals:
                top_pest = max(pest_totals, key=pest_totals.get)

            # Top disease by frequency
            disease_records = frappe.get_all(
                "Diseases Scouting Entry",
                filters={"parent": ["in", entry_names]},
                fields=["disease"]
            )
            disease_totals = {}
            for d in disease_records:
                if d.disease:
                    disease_totals[d.disease] = disease_totals.get(d.disease, 0) + 1
            if disease_totals:
                top_disease = max(disease_totals, key=disease_totals.get)

        frappe.response["message"] = {
            "date": date_str,
            "total_entries": total_entries,
            "scouts_active": scouts_active,
            "beds_scouted": beds_scouted,
            "zones_scouted": zones_scouted,
            "greenhouses_scouted": greenhouses_scouted,
            "top_pest": top_pest,
            "top_disease": top_disease
        }

    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Workspace Stats Error")
        frappe.throw(f"Error fetching workspace stats: {str(e)}")
