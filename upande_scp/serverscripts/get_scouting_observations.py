import frappe
import hashlib

@frappe.whitelist()
def getScoutingObservations():
    try:
        date_str = frappe.form_dict.get("date")
        if not date_str:
            frappe.throw("Date is required.")

  
        observation_configs = {
            "pests_scouting_entry": {
                "doctype": "Pest",
                "legend_color_field": "color",
                "child_table": "Pests Scouting Entry",
                "type_label": "Pests",
                "item_field": "pest",
                "extra_fields": ["plant_section", "stage", "count"]
            },
            "diseases_scouting_entry": {
                "doctype": "Plant Disease",
                "legend_color_field": "disease_legend_color",
                "child_table": "Diseases Scouting Entry",
                "type_label": "Diseases",
                "item_field": "disease",
                "extra_fields": ["plant_section", "stage"]
            },
            "predators_scouting_entry": {
                "doctype": "Predator",
                "legend_color_field": "color",
                "child_table": "Predators Scouting Entry",
                "type_label": "Predators",
                "item_field": "predator",
                "extra_fields": ["plant_section", "stage", "count"]
            },
            "weeds_scouting_entry": {
                "doctype": "Weed",
                "legend_color_field": "color",
                "child_table": "Weeds Scouting Entry",
                "type_label": "Weeds",
                "item_field": "weed",
                "extra_fields": []
            },
            "incidents_scouting_entry": {
                "doctype": "Incident",
                "legend_color_field": "color",
                "child_table": "Incidents Scouting Entry",
                "type_label": "Incidents",
                "item_field": "incident",
                "extra_fields": []
            },
            "physiological_disorders_entry": {
                "doctype": "Physiological Disorder",
                "legend_color_field": "color",
                "child_table": "Physiological Disorders Entry",
                "type_label": "Physiological Disorders",
                "item_field": "physiological_disorders",
                "extra_fields": []
            }
        }

        scouting_entries = frappe.get_all(
            "Scouting Entry",
            filters={"date_of_capture": date_str},
            fields=["name", "zone"],
            order_by="time_of_capture ASC"
        )
        entry_names = [e.name for e in scouting_entries]

        if not entry_names:
            frappe.response["message"] = {
                "scouting_entries": [],
                "all_zones_geojson": [],
                "active_observation_types": [],
                "all_observation_names": {},
                "observation_metadata": {k: {"label": v["type_label"]} for k, v in observation_configs.items()}
            }
            return

        processed_entries = {}
        for entry in scouting_entries:
            processed_entries[entry.name] = {"name": entry.name, "zone": entry.zone}
            for key in observation_configs:
                processed_entries[entry.name][key] = []


        all_observation_names = {}
        
        for key, cfg in observation_configs.items():
            fields = ["parent", cfg["item_field"]]
            meta = frappe.get_meta(cfg["child_table"])
            for f in cfg["extra_fields"]:
                if meta.has_field(f):
                    fields.append(f)

            items_in_data = {}
            
            try:
                child_records = frappe.get_all(
                    cfg["child_table"],
                    filters={"parent": ["in", entry_names]},
                    fields=fields
                )

                for rec in child_records:
                    parent = rec.parent
                    if parent not in processed_entries:
                        continue

                    item_name = rec.get(cfg["item_field"])
                    if not item_name:
                        continue

                    if item_name not in items_in_data:
                        items_in_data[item_name] = "#999999"  # Default gray

                    # Build observation object
                    obs_data = {
                        "name": item_name,
                        "color": "#999999"  # Will be updated below
                    }
                    
                    # Add extra fields if they exist
                    for field in cfg["extra_fields"]:
                        if field in rec:
                            obs_data[field] = rec[field]
                    
                    # Handle count field appropriately
                    if "count" in [f.fieldname for f in meta.fields] and "count" in rec:
                        obs_data["count"] = rec["count"]
                    elif key in ["diseases_scouting_entry", "incidents_scouting_entry", "physiological_disorders_entry", "weeds_scouting_entry"]:
                        # For boolean observations, default to 1 if no count
                        obs_data["count"] = 1
                    else:
                        obs_data["count"] = rec.get("count", 0)
                    
                    processed_entries[parent][key].append(obs_data)
                    
            except Exception as e:
                frappe.log_error(f"Failed to load {cfg['child_table']}: {str(e)}")
                continue  # Continue with next observation type

            # Now try to fetch colors for the items we found
            if items_in_data:
                try:
                    # Check if the color field exists in the main doctype
                    main_meta = frappe.get_meta(cfg["doctype"])
                    color_field_exists = any(f.fieldname == cfg["legend_color_field"] for f in main_meta.fields)
                    
                    if color_field_exists:
                        # Color field exists, try to fetch colors
                        color_records = frappe.get_all(
                            cfg["doctype"],
                            filters={"name": ["in", list(items_in_data.keys())]},
                            fields=["name", cfg["legend_color_field"]]
                        )
                        
                        # Build color map from actual data
                        for rec in color_records:
                            color = rec.get(cfg["legend_color_field"])
                            if color:  # Only update if color is not empty
                                items_in_data[rec.name] = color
                                print(f"Found color for {rec.name}: {color}")
                    else:
                        # Color field doesn't exist, use generated colors
                        print(f"Color field '{cfg['legend_color_field']}' not found in {cfg['doctype']}, using generated colors")
                    
                    # Generate consistent colors for any items still using default
                    for item_name in items_in_data:
                        if items_in_data[item_name] == "#999999":
                            # Generate consistent color based on item name hash
                            color_hash = hashlib.md5(item_name.encode()).hexdigest()[:6]
                            items_in_data[item_name] = f"#{color_hash}"
                            print(f"Generated color for {item_name}: #{color_hash}")
                            
                except Exception as e:
                    # If any error occurs, use generated colors for all items
                    print(f"Error fetching colors for {cfg['doctype']}: {e}, using generated colors")
                    for item_name in items_in_data:
                        color_hash = hashlib.md5(item_name.encode()).hexdigest()[:6]
                        items_in_data[item_name] = f"#{color_hash}"

                # Update colors in processed entries
                for entry_name in processed_entries:
                    for obs in processed_entries[entry_name][key]:
                        if obs["name"] in items_in_data:
                            obs["color"] = items_in_data[obs["name"]]

            # Store for legend
            all_observation_names[key] = [
                {"name": name, "color": color}
                for name, color in items_in_data.items()
            ]

        final_entries = []
        for entry in scouting_entries:
            e = {"name": entry.name, "zone": entry.zone}
            proc = processed_entries.get(entry.name, {})
            for key in observation_configs:
                e[key] = proc.get(key, [])
            final_entries.append(e)

      
        all_zones = frappe.get_all(
            "Zone",
            filters={"raw_geojson": ["is", "set"]},
            fields=["name", "raw_geojson"]
        )

     
        active_types = [
            key for key in observation_configs
            if all_observation_names.get(key)  # Has items
        ]

      
        frappe.response["message"] = {
            "scouting_entries": final_entries,
            "all_zones_geojson": all_zones or [],
            "active_observation_types": active_types,
            "all_observation_names": all_observation_names,
            "observation_metadata": {
                k: {"label": v["type_label"]} for k, v in observation_configs.items()
            }
        }

    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Scouting Observations Error")
        frappe.throw(f"Error fetching scouting data: {str(e)}")