import frappe

@frappe.whitelist()
def getScoutingObservations():
    try:
        date_str = frappe.form_dict.get("date")
        if not date_str:
            frappe.throw("The date is required.")

        all_pests_names = frappe.get_all("Pest", fields=["name", "pests_legend_color"])
        pest_name_list = [p.name for p in all_pests_names]

        all_severities = frappe.get_all(
            "Scouting Severity Scale",
            filters={"parent": ["in", pest_name_list]},
            fields=["parent", "from", "to", "color"]
        )

        all_stages = frappe.get_all(
            "Pests Stages",
            filters={"parent": ["in", pest_name_list]},
            fields=["parent", "stage", "symbol"]
        )

        pests_map = {p.name: {"severity": [], "stages": [], "pests_legend_color": p.pests_legend_color} for p in all_pests_names}
        for severity in all_severities:
            pests_map[severity.parent]["severity"].append(severity)
        for stage in all_stages:
            pests_map[stage.parent]["stages"].append(stage)

        scouting_entries = frappe.get_all(
            "Scouting Entry",
            filters=[["date_of_capture", "=", date_str]],
            fields=["name", "greenhouse", "bed", "zone", "latitude", "longitude"],
            order_by="time_of_capture asc"
        )

        entry_names = [entry.name for entry in scouting_entries]
        all_pest_entries = frappe.get_all(
            "Pests Scouting Entry",
            filters={"parent": ["in", entry_names]},
            fields=["parent", "pest", "count", "stage"]
        )

        pest_entries_by_parent = {}
        for pest_entry in all_pest_entries:
            parent = pest_entry.parent
            if parent not in pest_entries_by_parent:
                pest_entries_by_parent[parent] = []
            pest_entries_by_parent[parent].append(pest_entry)

        for entry in scouting_entries:
            pest_entries = pest_entries_by_parent.get(entry.name, [])
            processed_pests = []
            for pest_entry in pest_entries:
                pest_name = pest_entry.pest
                pest_count = pest_entry.count
                
                pest_info = pests_map.get(pest_name)
                if pest_info:
                    stage_symbol = "❓"
                    if pest_entry.stage and pest_info["stages"]:
                        for stage in pest_info["stages"]:
                            if stage.get("stage") == pest_entry.stage:
                                stage_symbol = stage.get("symbol")
                                break
                    
                    severity_color = "#cccccc"
                    if pest_info["severity"]:
                        for severity in pest_info["severity"]:
                            if float(severity.get("from")) <= pest_count <= float(severity.get("to")):
                                severity_color = severity.get("color")
                                break
                    
                    processed_pests.append({
                        "pest": pest_name,
                        "count": pest_count,
                        "symbol": stage_symbol,
                        "color": severity_color
                    })
            entry["pests_scouting_entry"] = processed_pests

        all_zones = frappe.get_all(
            "Zone",
            filters={"raw_geojson": ["is", "set"]},
            fields=["name", "raw_geojson"]
        )

        frappe.response["message"] = {
            "scouting_entries": scouting_entries,
            "all_zones_geojson": all_zones,
            "all_pests_names": all_pests_names
        }
        
    except Exception as e:
        frappe.throw("Error fetching panorama analysis: " + str(e))