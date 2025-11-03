import frappe
import hashlib
from frappe.utils import flt

@frappe.whitelist()
def getScoutingData():
    """
    Fetches scouting data + susceptibility per pest/disease.
    Thresholds are no longer returned in varieties.
    """
    try:
        greenhouse = frappe.form_dict.get("greenhouse")
        date_str = frappe.form_dict.get("date")

        if not greenhouse or not date_str:
            frappe.throw("Greenhouse and date are required.")

        # --- CONFIGURATION: Observation types ---
        observation_configs = {
            "pests_scouting_entry": {
                "doctype": "Pest",
                "child_table": "Pests Scouting Entry",
                "item_field": "pest",
                "type_label": "Pests",
                "legend_color_field": "color",
                "extra_fields": ["plant_section", "stage", "count"]
            },
            "diseases_scouting_entry": {
                "doctype": "Plant Disease",
                "child_table": "Diseases Scouting Entry",
                "item_field": "disease",
                "type_label": "Diseases",
                "legend_color_field": "disease_legend_color",
                "extra_fields": ["plant_section", "stage"]
            },
            "predators_scouting_entry": {
                "doctype": "Predator",
                "child_table": "Predators Scouting Entry",
                "item_field": "predator",
                "type_label": "Predators",
                "legend_color_field": "color",
                "extra_fields": ["plant_section", "stage", "count"]
            },
            "weeds_scouting_entry": {
                "doctype": "Weed",
                "child_table": "Weeds Scouting Entry",
                "item_field": "weed",
                "type_label": "Weeds",
                "legend_color_field": "color",
                "extra_fields": []
            },
            "incidents_scouting_entry": {
                "doctype": "Incident",
                "child_table": "Incidents Scouting Entry",
                "item_field": "incident",
                "type_label": "Incidents",
                "legend_color_field": "color",
                "extra_fields": []
            },
            "physiological_disorders_scouting_entry": {
                "doctype": "Physiological Disorder",
                "child_table": "Physiological Disorders Entry",
                "item_field": "physiological_disorders",
                "type_label": "Physiological Disorders",
                "legend_color_field": "color",
                "extra_fields": []
            }
        }
        
        # --- 1. Fetch Scouting Entries ---
        scouting_entries = frappe.get_all(
            "Scouting Entry",
            fields=["name", "bed", "zone", "time_of_capture", "scouts_name"], 
            filters=[
                ["greenhouse", "=", greenhouse],
                ["date_of_capture", "=", date_str]
            ],
            order_by="time_of_capture ASC"
        )
        entry_names = [e.name for e in scouting_entries]

        if not entry_names:
            return { 
                "scouting_entries": [], 
                "varieties": [], 
                "susceptibility": [],
                "boms": [], 
                "observation_metadata": {}
            }

        processed_entries = {e.name: dict(e) for e in scouting_entries}

        # --- 2. Pest Config (severity/stage) ---
        pest_names = frappe.get_all("Pest", fields=["name"])
        pests_map = {p.name: {"severity": [], "stages": []} for p in pest_names}

        for severity in frappe.get_all("Scouting Severity Scale", filters={"parent": ["in", [p.name for p in pest_names]]}, fields=["parent", "from", "to", "color"]):
            pests_map[severity.parent]["severity"].append(severity)

        for stage in frappe.get_all("Pests Stages", filters={"parent": ["in", [p.name for p in pest_names]]}, fields=["parent", "stage", "symbol"]):
            pests_map[stage.parent]["stages"].append(stage)

        # --- 3. Process All Observation Types ---
        all_observation_names = {}
        
        for key, cfg in observation_configs.items():
            fields = ["parent", cfg["item_field"]] + cfg["extra_fields"]
            meta = frappe.get_meta(cfg["child_table"])
            final_fields = [f for f in fields if meta.has_field(f) or f == "parent"]

            try:
                child_records = frappe.get_all(
                    cfg["child_table"],
                    filters={"parent": ["in", entry_names]},
                    fields=final_fields
                )
            except Exception as e:
                frappe.log_error(f"Error fetching {cfg['child_table']}: {str(e)}")
                continue
            
            items_in_data = {}

            for rec in child_records:
                parent = rec.parent
                if parent not in processed_entries:
                    continue

                item_name = rec.get(cfg["item_field"])
                if not item_name:
                    continue
                
                if item_name not in items_in_data:
                    items_in_data[item_name] = "#999999"

                obs_data = {"name": item_name, "color": "#999999"} 

                for field in cfg["extra_fields"]:
                    if field in rec:
                        obs_data[field] = rec[field]
                
                # Pest stage/severity
                if key == "pests_scouting_entry":
                    pest_count = flt(rec.get("count"))
                    pest_info = pests_map.get(item_name)
                    if pest_info:
                        if rec.get("stage") and pest_info.get("stages"):
                            for s in pest_info["stages"]:
                                if s.get("stage") == rec.get("stage"):
                                    obs_data["symbol"] = s.get("symbol")
                                    break
                        if pest_info.get("severity"):
                            for s in pest_info["severity"]:
                                if flt(s.get("from")) <= pest_count <= flt(s.get("to")):
                                    obs_data["color"] = s.get("color")
                                    break

                if key not in processed_entries[parent]:
                    processed_entries[parent][key] = []
                processed_entries[parent][key].append(obs_data)
            
            # Color handling
            if items_in_data:
                main_doctype = cfg["doctype"]
                color_field = cfg["legend_color_field"]
                main_meta = frappe.get_meta(main_doctype)
                
                if main_meta.has_field(color_field):
                    try:
                        colors = frappe.get_all(
                            main_doctype,
                            filters={"name": ["in", list(items_in_data.keys())]},
                            fields=["name", color_field]
                        )
                        for c in colors:
                            if c.get(color_field):
                                items_in_data[c.name] = c.get(color_field)
                    except Exception as e:
                        frappe.log_error(f"Color fetch error {main_doctype}: {str(e)}")
                
                for name in items_in_data:
                    if items_in_data[name] == "#999999":
                        items_in_data[name] = f"#{hashlib.md5(name.encode()).hexdigest()[:6]}"
                
                for entry in processed_entries.values():
                    for obs in entry.get(key, []):
                        if obs["name"] in items_in_data:
                            obs["color"] = items_in_data[obs["name"]]
                            
                all_observation_names[key] = [
                    {"name": n, "color": c} for n, c in items_in_data.items()
                ]

        final_scouting_entries = list(processed_entries.values())

        # --- 4. Varieties (no thresholds) ---
        varieties_planted_in_gh = frappe.get_all("Items Greenhouses", filters={"parent": greenhouse}, fields=["variety"])
        variety_names = [v.variety for v in varieties_planted_in_gh]
        varieties_data = [{"name": v_name} for v_name in variety_names]

        # --- 5. Compute Susceptibility (uses thresholds from Item) ---
        item_thresholds = frappe.get_all(
            "Chemical Requirements",
            filters={"parent": ["in", variety_names]},
            fields=["parent", "pest", "disease", "low", "moderate", "high"]
        )

        thresholds_by_variety = {}
        for t in item_thresholds:
            v = t.parent
            if v not in thresholds_by_variety:
                thresholds_by_variety[v] = []
            thresholds_by_variety[v].append({
                "pest": t.pest,
                "disease": t.disease,
                "low": t.low,
                "moderate": t.moderate,
                "high": t.high
            })

        total_zones = len(set(e.zone for e in scouting_entries if e.zone)) or 1

        affected_by_obs = {}
        for entry in scouting_entries:
            for key in ["pests_scouting_entry", "diseases_scouting_entry"]:
                for obs in processed_entries.get(entry.name, {}).get(key, []):
                    name = obs["name"]
                    if name not in affected_by_obs:
                        affected_by_obs[name] = {
                            "zones": set(),
                            "type": "pest" if key.startswith("pests") else "disease"
                        }
                    affected_by_obs[name]["zones"].add(entry.zone)

        susceptibility = []
        for obs_name, data in affected_by_obs.items():
            zones_affected = len(data["zones"])
            percentage = round((zones_affected / total_zones) * 100, 2)

            req_by_variety = {}
            for v in varieties_data:
                variety = v["name"]
                thresh_list = thresholds_by_variety.get(variety, [])
                match = next(
                    (t for t in thresh_list
                     if (t["pest"] == obs_name if data["type"] == "pest" else t["disease"] == obs_name)),
                    None
                )
                if not match:
                    req_by_variety[variety] = "unknown"
                    continue

                if percentage <= match["low"]:
                    level = "low"
                elif percentage <= match["moderate"]:
                    level = "moderate"
                elif percentage <= match["high"]:
                    level = "high"
                else:
                    level = "high"
                req_by_variety[variety] = level

            susceptibility.append({
                "observation": obs_name,
                "type": data["type"],
                "zones_affected": zones_affected,
                "total_zones": total_zones,
                "percentage": percentage,
                "requirement_by_variety": req_by_variety
            })

        # --- 6. BOMs, Chemicals, etc. ---
        chemical_mix_boms = frappe.get_all(
            "BOM", 
            filters={"custom_item_group": "Chemical Mix", "docstatus": 1, "is_active": 1}, 
            fields=["name", "custom_water_ph", "custom_water_hardness"]
        )
        bom_names = [b["name"] for b in chemical_mix_boms]
        bom_items = frappe.db.get_all("BOM Item", filters={"parent": ["in", bom_names]}, fields=["parent", "item_name", "qty", "uom"])

        bed_zone_numbering = frappe.get_all("Warehouse", filters={"name": greenhouse}, fields=["custom_bed_numbering", "custom_zone_numbering"])
        chemicals = frappe.db.get_list('Item', filters={'item_group': 'CHEMICALS'}, fields=['item_name'])
        all_chemicals = sorted({c.item_name for c in chemicals})

        bed_data = frappe.get_all("Bed", filters={"greenhouse": greenhouse}, fields=["bed", "bed__area", "total_variety_area", "variety"])
        spray_teams = frappe.get_all("Spray Team", filters={"enabled": 1}, fields=["name"])

        # --- 7. Final Response ---
        return {
            "scouting_entries": final_scouting_entries,
            "susceptibility": susceptibility,
            "boms": chemical_mix_boms,
            "bom_items": bom_items,
            "custom_bed_numbering": bed_zone_numbering[0].get("custom_bed_numbering") if bed_zone_numbering else None,
            "custom_zone_numbering": bed_zone_numbering[0].get("custom_zone_numbering") if bed_zone_numbering else None,
            "all_chemicals": all_chemicals,
            "bed_data": bed_data,
            "spray_team_team": spray_teams,
            "observation_metadata": {
                "active_observation_types": [k for k in observation_configs if all_observation_names.get(k)],
                "all_observation_names": all_observation_names,
                "type_labels": {k: v["type_label"] for k, v in observation_configs.items()}
            }
        }

    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "getScoutingData Error")
        frappe.throw(f"Error: {str(e)}")