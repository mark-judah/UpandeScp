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

        # Pre-compute meta fields once — avoids 12 get_meta() calls inside the loop
        boolean_types = {
            "diseases_scouting_entry", "incidents_scouting_entry",
            "physiological_disorders_entry", "weeds_scouting_entry"
        }
        for key, cfg in observation_configs.items():
            meta = frappe.get_meta(cfg["child_table"])
            cfg["_fetch_fields"] = ["parent", cfg["item_field"]] + [
                f for f in cfg["extra_fields"] if meta.has_field(f)
            ]
            cfg["_has_count"] = "count" in [f.fieldname for f in meta.fields]
            main_meta = frappe.get_meta(cfg["doctype"])
            cfg["_color_field_exists"] = any(
                f.fieldname == cfg["legend_color_field"] for f in main_meta.fields
            )

        greenhouse = frappe.form_dict.get("greenhouse") or ""

        se_filters = {"date_of_capture": date_str}
        if greenhouse:
            se_filters["greenhouse"] = greenhouse

        scouting_entries = frappe.get_all(
            "Scouting Entry",
            filters=se_filters,
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
            items_in_data = {}

            try:
                child_records = frappe.get_all(
                    cfg["child_table"],
                    filters={"parent": ["in", entry_names]},
                    fields=cfg["_fetch_fields"]
                )

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

                    if cfg["_has_count"] and "count" in rec:
                        obs_data["count"] = rec["count"]
                    elif key in boolean_types:
                        obs_data["count"] = 1
                    else:
                        obs_data["count"] = rec.get("count", 0)

                    processed_entries[parent][key].append(obs_data)

            except Exception as e:
                frappe.log_error(f"Failed to load {cfg['child_table']}: {str(e)}")
                continue

            if items_in_data:
                # Colors are cached in Redis — they almost never change day-to-day
                color_cache_key = f"scp_obs_colors_{key}"
                full_color_map = frappe.cache().get_value(color_cache_key)

                if full_color_map is None:
                    full_color_map = {}
                    try:
                        if cfg["_color_field_exists"]:
                            for rec in frappe.get_all(
                                cfg["doctype"],
                                fields=["name", cfg["legend_color_field"]]
                            ):
                                name = rec.get("name")
                                color = rec.get(cfg["legend_color_field"])
                                if name:
                                    if color:
                                        full_color_map[name] = color
                                    else:
                                        color_hash = hashlib.md5(name.encode()).hexdigest()[:6]
                                        full_color_map[name] = f"#{color_hash}"
                    except Exception:
                        pass
                    frappe.cache().set_value(color_cache_key, full_color_map, expires_in_sec=86400)

                for item_name in list(items_in_data.keys()):
                    if item_name in full_color_map:
                        items_in_data[item_name] = full_color_map[item_name]
                    else:
                        color_hash = hashlib.md5(item_name.encode()).hexdigest()[:6]
                        items_in_data[item_name] = f"#{color_hash}"

                for entry_name in processed_entries:
                    for obs in processed_entries[entry_name][key]:
                        if obs["name"] in items_in_data:
                            obs["color"] = items_in_data[obs["name"]]

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

        # Zone GeoJSON is cached in Redis — geometry doesn't change between requests
        zone_cache_key = "scp_zone_geojson"
        all_zones_raw = frappe.cache().get_value(zone_cache_key)
        if all_zones_raw is None:
            all_zones_raw = frappe.get_all(
                "Zone",
                filters={"raw_geojson": ["is", "set"]},
                fields=["name", "raw_geojson"]
            )
            frappe.cache().set_value(zone_cache_key, all_zones_raw, expires_in_sec=3600)

        # Filter to only zones referenced by today's entries — done in Python, no DB round trip
        entry_zones_set = {e.zone for e in scouting_entries if e.zone}
        all_zones = [z for z in all_zones_raw if z.get("name") in entry_zones_set]

        active_types = [
            key for key in observation_configs
            if all_observation_names.get(key)
        ]

        frappe.response["message"] = {
            "scouting_entries": final_entries,
            "all_zones_geojson": all_zones,
            "active_observation_types": active_types,
            "all_observation_names": all_observation_names,
            "observation_metadata": {
                k: {"label": v["type_label"]} for k, v in observation_configs.items()
            }
        }

    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Scouting Observations Error")
        frappe.throw(f"Error fetching scouting data: {str(e)}")
