import frappe
import hashlib

@frappe.whitelist()
def getScoutingObservations():
    try:
        date_str = frappe.form_dict.get("date")
        if not date_str:
            frappe.throw("Date is required.")

        greenhouse = frappe.form_dict.get("greenhouse") or ""

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
            },
            "crop_husbandry_practices_entry": {
                "doctype": "Crop Husbandry Practices",
                "legend_color_field": "color",
                "child_table": "Crop Husbandry Practices Entry",
                "type_label": "Crop Husbandry Practices",
                "item_field": "crop_husbandry_practices",
                "extra_fields": []
            }
        }

        # Build filters for Scouting Entry
        se_filters = {"date_of_capture": date_str}
        if greenhouse:
            se_filters["greenhouse"] = greenhouse

        scouting_entries = frappe.get_all(
            "Scouting Entry",
            filters=se_filters,
            fields=["name", "zone", "scouts_name", "bed", "greenhouse"],
            order_by="time_of_capture ASC"
        )
        entry_names = [e.name for e in scouting_entries]

        # Compute summary stats
        scouts_count = len({e.scouts_name for e in scouting_entries if e.scouts_name})
        beds_count = len({e.bed for e in scouting_entries if e.bed})
        zones_scouted = len({e.zone for e in scouting_entries if e.zone})

        if not entry_names:
            frappe.response["message"] = {
                "scouting_entries": [],
                "all_zones_geojson": [],
                "active_observation_types": [],
                "all_observation_names": {},
                "observation_metadata": {k: {"label": v["type_label"]} for k, v in observation_configs.items()},
                "summary": {
                    "scouts_count": 0,
                    "beds_count": 0,
                    "zones_scouted": 0
                }
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
                        items_in_data[item_name] = "#999999"

                    obs_data = {
                        "name": item_name,
                        "color": "#999999"
                    }

                    for field in cfg["extra_fields"]:
                        if field in rec:
                            obs_data[field] = rec[field]

                    if "count" in [f.fieldname for f in meta.fields] and "count" in rec:
                        obs_data["count"] = rec["count"]
                    elif key in ["diseases_scouting_entry", "incidents_scouting_entry", "physiological_disorders_entry", "weeds_scouting_entry"]:
                        obs_data["count"] = 1
                    else:
                        obs_data["count"] = rec.get("count", 0)

                    processed_entries[parent][key].append(obs_data)

            except Exception as e:
                frappe.log_error(f"Failed to load {cfg['child_table']}: {str(e)}")
                continue

            if items_in_data:
                try:
                    main_meta = frappe.get_meta(cfg["doctype"])
                    color_field_exists = any(f.fieldname == cfg["legend_color_field"] for f in main_meta.fields)

                    if color_field_exists:
                        color_records = frappe.get_all(
                            cfg["doctype"],
                            filters={"name": ["in", list(items_in_data.keys())]},
                            fields=["name", cfg["legend_color_field"]]
                        )
                        for rec in color_records:
                            color = rec.get(cfg["legend_color_field"])
                            if color:
                                items_in_data[rec.name] = color

                    for item_name in items_in_data:
                        if items_in_data[item_name] == "#999999":
                            color_hash = hashlib.md5(item_name.encode()).hexdigest()[:6]
                            items_in_data[item_name] = f"#{color_hash}"

                except Exception as e:
                    for item_name in items_in_data:
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

        # Fetch only zones referenced by entries in scope (much faster with greenhouse filter)
        entry_zones = list({e.zone for e in scouting_entries if e.zone})
        if entry_zones:
            all_zones = frappe.get_all(
                "Zone",
                filters={"name": ["in", entry_zones], "raw_geojson": ["is", "set"]},
                fields=["name", "raw_geojson"]
            )
        else:
            all_zones = []

        active_types = [
            key for key in observation_configs
            if all_observation_names.get(key)
        ]

        frappe.response["message"] = {
            "scouting_entries": final_entries,
            "all_zones_geojson": all_zones or [],
            "active_observation_types": active_types,
            "all_observation_names": all_observation_names,
            "observation_metadata": {
                k: {"label": v["type_label"]} for k, v in observation_configs.items()
            },
            "summary": {
                "scouts_count": scouts_count,
                "beds_count": beds_count,
                "zones_scouted": zones_scouted
            }
        }

    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Scouting Observations Error")
        frappe.throw(f"Error fetching scouting data: {str(e)}")


def _pick_first_existing_field(doctype, fieldnames):
    meta = frappe.get_meta(doctype)
    for fieldname in fieldnames:
        if meta.has_field(fieldname):
            return fieldname
    return None


def _resolve_colors(doctype, candidate_fields, names):
    names = {n for n in (names or []) if n}
    if not names:
        return {}

    color_field = _pick_first_existing_field(doctype, candidate_fields)
    colors = {}

    if color_field:
        for rec in frappe.get_all(
            doctype, filters={"name": ["in", list(names)]}, fields=["name", color_field]
        ):
            color = rec.get(color_field)
            if color:
                colors[rec["name"]] = color

    for name in names:
        if name not in colors:
            color_hash = hashlib.md5(name.encode()).hexdigest()[:6]
            colors[name] = f"#{color_hash}"

    return colors


@frappe.whitelist()
def getTopPestDiseaseByGreenhouse():
    try:
        date_str = frappe.form_dict.get("date")
        if not date_str:
            frappe.throw("Date is required.")

        greenhouse_filter = frappe.form_dict.get("greenhouse") or ""
        se_filters = {"date_of_capture": date_str}
        if greenhouse_filter:
            se_filters["greenhouse"] = greenhouse_filter

        entries = frappe.get_all(
            "Scouting Entry",
            filters=se_filters,
            fields=["name", "greenhouse"],
            order_by="greenhouse ASC",
        )

        if not entries:
            frappe.response["message"] = {"greenhouses": [], "max_pest": 0, "max_disease": 0}
            return

        entry_to_gh = {e["name"]: e.get("greenhouse") for e in entries if e.get("greenhouse")}
        entry_names = list(entry_to_gh.keys())
        gh_names = sorted(set(entry_to_gh.values()))

        warehouse_rows = frappe.get_all(
            "Warehouse",
            filters={"name": ["in", gh_names]},
            fields=["name", "warehouse_name"],
        )
        gh_labels = {w["name"]: w.get("warehouse_name") or w["name"] for w in warehouse_rows}

        pest_counts = {gh: {} for gh in gh_names}
        for rec in frappe.get_all(
            "Pests Scouting Entry",
            filters={"parent": ["in", entry_names]},
            fields=["parent", "pest", "count"],
        ):
            gh = entry_to_gh.get(rec.get("parent"))
            pest = rec.get("pest")
            if not gh or not pest:
                continue
            count = rec.get("count")
            try:
                count = int(count) if count is not None else 1
            except Exception:
                count = 1
            pest_counts[gh][pest] = pest_counts[gh].get(pest, 0) + max(count, 1)

        disease_counts = {gh: {} for gh in gh_names}
        for rec in frappe.get_all(
            "Diseases Scouting Entry",
            filters={"parent": ["in", entry_names]},
            fields=["parent", "disease"],
        ):
            gh = entry_to_gh.get(rec.get("parent"))
            disease = rec.get("disease")
            if not gh or not disease:
                continue
            disease_counts[gh][disease] = disease_counts[gh].get(disease, 0) + 1

        pest_names = {name for by_pest in pest_counts.values() for name in by_pest.keys()}
        disease_names = {name for by_dis in disease_counts.values() for name in by_dis.keys()}

        pest_colors = _resolve_colors("Pest", ["pests_legend_color", "color"], pest_names)
        disease_colors = _resolve_colors(
            "Plant Disease", ["disease_legend_color", "color"], disease_names
        )

        max_pest = 0
        max_disease = 0
        rows = []

        for gh in gh_names:
            pest = {"name": "", "count": 0, "color": "#e5e7eb"}
            disease = {"name": "", "count": 0, "color": "#e5e7eb"}

            if pest_counts.get(gh):
                pest_name, pest_count = max(pest_counts[gh].items(), key=lambda kv: kv[1])
                pest = {
                    "name": pest_name,
                    "count": pest_count,
                    "color": pest_colors.get(pest_name) or "#e5e7eb",
                }
                max_pest = max(max_pest, pest_count)

            if disease_counts.get(gh):
                dis_name, dis_count = max(disease_counts[gh].items(), key=lambda kv: kv[1])
                disease = {
                    "name": dis_name,
                    "count": dis_count,
                    "color": disease_colors.get(dis_name) or "#e5e7eb",
                }
                max_disease = max(max_disease, dis_count)

            rows.append(
                {
                    "name": gh,
                    "label": gh_labels.get(gh) or gh,
                    "pest": pest,
                    "disease": disease,
                }
            )

        frappe.response["message"] = {
            "greenhouses": rows,
            "max_pest": max_pest,
            "max_disease": max_disease,
        }
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Top Pest/Disease By Greenhouse Error")
        frappe.throw(f"Error fetching top observations: {str(e)}")
