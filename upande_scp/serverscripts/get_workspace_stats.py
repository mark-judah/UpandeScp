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
        
        # NEW: Get greenhouse details for the bar graph
        greenhouse_details = []

        if entries:
            entry_names = [e.name for e in entries]

            # Get all pest records
            pest_records = frappe.get_all(
                "Pests Scouting Entry",
                filters={"parent": ["in", entry_names]},
                fields=["parent", "pest", "count"]
            )
            
            # Get all disease records
            disease_records = frappe.get_all(
                "Diseases Scouting Entry",
                filters={"parent": ["in", entry_names]},
                fields=["parent", "disease"]
            )

            # Create mapping of entry name to greenhouse
            entry_to_greenhouse = {e.name: e.greenhouse for e in entries if e.greenhouse}
            
            # Group by greenhouse
            greenhouse_pests = {}
            greenhouse_diseases = {}
            
            # Process pests by greenhouse
            for p in pest_records:
                if p.pest and p.parent in entry_to_greenhouse:
                    gh = entry_to_greenhouse[p.parent]
                    if gh not in greenhouse_pests:
                        greenhouse_pests[gh] = {}
                    count = p.count or 1
                    greenhouse_pests[gh][p.pest] = greenhouse_pests[gh].get(p.pest, 0) + count
            
            # Process diseases by greenhouse
            for d in disease_records:
                if d.disease and d.parent in entry_to_greenhouse:
                    gh = entry_to_greenhouse[d.parent]
                    if gh not in greenhouse_diseases:
                        greenhouse_diseases[gh] = {}
                    greenhouse_diseases[gh][d.disease] = greenhouse_diseases[gh].get(d.disease, 0) + 1

            # Calculate overall top pest and disease
            pest_totals = {}
            for p in pest_records:
                if p.pest:
                    pest_totals[p.pest] = pest_totals.get(p.pest, 0) + (p.count or 1)
            if pest_totals:
                top_pest = max(pest_totals, key=pest_totals.get)

            disease_totals = {}
            for d in disease_records:
                if d.disease:
                    disease_totals[d.disease] = disease_totals.get(d.disease, 0) + 1
            if disease_totals:
                top_disease = max(disease_totals, key=disease_totals.get)

            # Build greenhouse_details array for all greenhouses with activity
            all_greenhouses = set(entry_to_greenhouse.values())
            for gh in all_greenhouses:
                if not gh:
                    continue
                    
                # Get top pest for this greenhouse
                gh_pest = None
                gh_pest_count = 0
                if gh in greenhouse_pests and greenhouse_pests[gh]:
                    gh_pest = max(greenhouse_pests[gh], key=greenhouse_pests[gh].get)
                    gh_pest_count = greenhouse_pests[gh][gh_pest]
                
                # Get top disease for this greenhouse
                gh_disease = None
                gh_disease_count = 0
                if gh in greenhouse_diseases and greenhouse_diseases[gh]:
                    gh_disease = max(greenhouse_diseases[gh], key=greenhouse_diseases[gh].get)
                    gh_disease_count = greenhouse_diseases[gh][gh_disease]
                
                # Only include greenhouses that have at least one observation
                if gh_pest_count > 0 or gh_disease_count > 0:
                    greenhouse_details.append({
                        "name": gh,
                        "pest": gh_pest or "None",
                        "pestCount": gh_pest_count,
                        "disease": gh_disease or "None",
                        "diseaseCount": gh_disease_count
                    })

        frappe.response["message"] = {
            "date": date_str,
            "total_entries": total_entries,
            "scouts_active": scouts_active,
            "beds_scouted": beds_scouted,
            "zones_scouted": zones_scouted,
            "greenhouses_scouted": greenhouses_scouted,
            "top_pest": top_pest,
            "top_disease": top_disease,
            "greenhouse_details": greenhouse_details  # <-- ADDED THIS
        }

    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Workspace Stats Error")
        frappe.throw(f"Error fetching workspace stats: {str(e)}")