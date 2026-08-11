import re

import frappe
import hashlib
from frappe.utils import flt

from upande_scp.serverscripts.common.cache_utils import (
    K_CHEMICALS_LIST,
    K_ZONE_COUNT_BY_BED,
    TTL_MEDIUM,
    TTL_SHORT,
    build_zone_count_by_bed,
    get_or_set,
)
from upande_scp.serverscripts.common.crop_protection import (
    is_foliar_group,
    product_groups,
)


_BED_NUM_RE = re.compile(r"Bed\s+(\d+)", re.IGNORECASE)


def _cached_bom_items():
    def _build():
        rows = frappe.db.get_list(
            "Item",
            filters={"item_group": ["in", list(product_groups())], "disabled": 0},
            fields=["item_name", "item_group"],
            limit_page_length=0,
        )
        chemicals = set()
        fertilizers = set()
        type_map = {}
        for r in rows:
            if not r.item_name:
                continue
            if is_foliar_group(r.item_group):
                fertilizers.add(r.item_name)
                type_map[r.item_name] = "fertilizer"
            else:
                chemicals.add(r.item_name)
                type_map[r.item_name] = "chemical"
        return {
            "chemicals": sorted(chemicals),
            "fertilizers": sorted(fertilizers),
            "item_type_map": type_map,
        }

    return get_or_set(K_CHEMICALS_LIST, _build, ttl=TTL_MEDIUM)


@frappe.whitelist()
def getScoutingData():
    """
    Fetches scouting data + susceptibility per pest/disease.
    Returns the last 2 scouting report dates so the UI can overlay them.
    Now also returns varieties, BOMs, chemicals, bed data, and spray teams
    even when no scouting reports exist for the greenhouse.
    """
    try:
        greenhouse = frappe.form_dict.get("greenhouse")

        if not greenhouse:
            frappe.throw("Greenhouse is required.")

        # ── Get last 2 distinct scouting dates ──────────────────────────
        latest_dates = frappe.get_all(
            "Scouting Entry",
            filters={"greenhouse": greenhouse},
            fields=["date_of_capture"],
            order_by="date_of_capture DESC",
            limit=2,
            distinct=True,
            group_by="date_of_capture"
        )

        date_str      = str(latest_dates[0].date_of_capture) if latest_dates else None
        prev_date_str = str(latest_dates[1].date_of_capture) if len(latest_dates) > 1 else None

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

        # ── Helper: fetch + process entries for a given date ───────────
        def fetch_entries_for_date(target_date):
            if not target_date:
                return [], {}

            entries = frappe.get_all(
                "Scouting Entry",
                fields=["name", "bed", "zone", "time_of_capture", "scouts_name"],
                filters=[
                    ["greenhouse", "=", greenhouse],
                    ["date_of_capture", "=", target_date]
                ],
                order_by="time_of_capture ASC"
            )
            entry_names = [e.name for e in entries]
            if not entry_names:
                return [], {}

            processed = {e.name: dict(e) for e in entries}

            # Pest stage/severity config — stages now live on Pest Filter
            # rows (per-crop). Aggregate across crops, dedup by stage name.
            pest_names = frappe.get_all("Pest", fields=["name"])
            pests_map = {p.name: {"severity": [], "stages": []} for p in pest_names}
            for severity in frappe.get_all(
                "Scouting Severity Scale",
                filters={"parent": ["in", [p.name for p in pest_names]]},
                fields=["parent", "from", "to", "color"]
            ):
                pests_map[severity.parent]["severity"].append(severity)

            pest_filter_rows = frappe.get_all(
                "Pest Filter",
                fields=["name", "pest"],
                limit_page_length=0,
            )
            row_to_pest = {r.name: r.pest for r in pest_filter_rows}
            stage_icons = {
                s.name: (s.icon_key or "")
                for s in frappe.get_all("Stage", fields=["name", "icon_key"], limit_page_length=0)
            }
            if row_to_pest:
                seen_pest_stage = set()
                for stage in frappe.get_all(
                    "Pests Stages",
                    filters={
                        "parent": ["in", list(row_to_pest.keys())],
                        "parenttype": "Pest Filter",
                    },
                    fields=["parent", "stage"],
                    limit_page_length=0,
                ):
                    pest_name = row_to_pest.get(stage.parent)
                    if not pest_name or pest_name not in pests_map:
                        continue
                    key = (pest_name, stage.stage)
                    if key in seen_pest_stage:
                        continue
                    seen_pest_stage.add(key)
                    pests_map[pest_name]["stages"].append({
                        "parent": pest_name,
                        "stage": stage.stage,
                        "symbol": stage_icons.get(stage.stage, ""),
                    })

            items_in_data_all = {}  # key → {name: color}

            # Hoist meta lookups out of the loop — 12 get_meta calls → 12 once, cached
            child_meta_cache = {
                cfg["child_table"]: frappe.get_meta(cfg["child_table"])
                for cfg in observation_configs.values()
            }
            main_meta_cache = {
                cfg["doctype"]: frappe.get_meta(cfg["doctype"])
                for cfg in observation_configs.values()
            }

            for key, cfg in observation_configs.items():
                fields = ["parent", cfg["item_field"]] + cfg["extra_fields"]
                meta = child_meta_cache[cfg["child_table"]]
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
                    if parent not in processed:
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

                    if key not in processed[parent]:
                        processed[parent][key] = []
                    processed[parent][key].append(obs_data)

                # Resolve colors from main DocType
                if items_in_data:
                    main_doctype = cfg["doctype"]
                    color_field  = cfg["legend_color_field"]
                    main_meta    = main_meta_cache[main_doctype]

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

                    for entry in processed.values():
                        for obs in entry.get(key, []):
                            if obs["name"] in items_in_data:
                                obs["color"] = items_in_data[obs["name"]]

                    items_in_data_all[key] = items_in_data

            return list(processed.values()), items_in_data_all

        # ── Fetch both reports (safe even when dates are None) ─────────
        latest_entries, items_latest     = fetch_entries_for_date(date_str)
        previous_entries, items_previous = fetch_entries_for_date(prev_date_str)

        # ── Merge observation name maps (union of both reports) ─────────
        all_observation_names = {}
        for key in observation_configs:
            merged = {}
            for src in [items_latest, items_previous]:
                for name, color in src.get(key, {}).items():
                    if name not in merged:
                        merged[name] = color
            if merged:
                all_observation_names[key] = [{"name": n, "color": c} for n, c in merged.items()]

        # --- Varieties (always fetched, independent of scouting data) ---
        varieties_data = []
        variety_names  = []

        karen_doctype = "Items Greenhouses"
        mona_doctype  = "Varieties per GH"

        if frappe.db.exists("DocType", karen_doctype):
            if frappe.db.exists(karen_doctype, {"parent": greenhouse}):
                rows = frappe.get_all(
                    karen_doctype,
                    filters={"parent": greenhouse},
                    fields=["variety", "area"]
                )
                for row in rows:
                    if not row.variety:
                        continue
                    item = {"name": row.variety}
                    if row.area is not None:
                        item["area"] = flt(row.area)
                    varieties_data.append(item)
                variety_names = [v["name"] for v in varieties_data]

        if not varieties_data:
            if frappe.db.exists("DocType", mona_doctype):
                if frappe.db.exists(mona_doctype, {"parent": greenhouse}):
                    rows = frappe.get_all(
                        mona_doctype,
                        filters={"parent": greenhouse},
                        fields=["variety"]
                    )
                    varieties_data = [{"name": row.variety} for row in rows if row.variety]
                    variety_names  = [v["name"] for v in varieties_data]

        # --- Susceptibility (only computed when scouting data exists) ---
        susceptibility = []
        if date_str:
            scouting_entries_for_sus = frappe.get_all(
                "Scouting Entry",
                fields=["name", "bed", "zone"],
                filters=[
                    ["greenhouse", "=", greenhouse],
                    ["date_of_capture", "=", date_str]
                ]
            )

            item_thresholds = frappe.get_all(
                "Chemical Requirements",
                filters={"parent": ["in", variety_names]} if variety_names else {"parent": ""},
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

            total_zones = len(set(e.zone for e in scouting_entries_for_sus if e.zone)) or 1
            affected_by_obs = {}
            latest_by_name  = {e["name"]: e for e in latest_entries}

            for entry in scouting_entries_for_sus:
                processed_entry = latest_by_name.get(entry.name, {})
                for key in ["pests_scouting_entry", "diseases_scouting_entry"]:
                    for obs in processed_entry.get(key, []):
                        name = obs["name"]
                        if name not in affected_by_obs:
                            affected_by_obs[name] = {
                                "zones": set(),
                                "type": "pest" if key.startswith("pests") else "disease"
                            }
                        affected_by_obs[name]["zones"].add(entry.zone)

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

        # --- BOMs (always fetched) ---
        chemical_mix_boms = frappe.get_all(
            "BOM",
            filters={"custom_item_group": "Chemical Mix", "docstatus": 1, "is_active": 1},
            fields=["name", "custom_water_ph", "custom_water_hardness"]
        )
        bom_names = [b["name"] for b in chemical_mix_boms]
        bom_items = frappe.db.get_all(
            "BOM Item",
            filters={"parent": ["in", bom_names]} if bom_names else {"parent": ""},
            fields=["parent", "item_name", "qty", "uom"]
        )

        bed_zone_numbering = frappe.get_all(
            "Warehouse",
            filters={"name": greenhouse},
            fields=["custom_bed_numbering", "custom_zone_numbering"]
        )
        bom_item_lookup = _cached_bom_items()
        all_chemicals = bom_item_lookup["chemicals"]
        all_fertilizers = bom_item_lookup["fertilizers"]
        item_type_map = bom_item_lookup["item_type_map"]
        bed_data     = frappe.get_all("Bed", filters={"greenhouse": greenhouse}, fields=["bed", "bed_area as bed__area", "variety"])
        # total_variety_area is no longer a stored field: compute it as the sum
        # of bed areas across all beds of the same variety in this greenhouse.
        _variety_area: dict = {}
        for _b in bed_data:
            if _b.get("variety"):
                _variety_area[_b["variety"]] = _variety_area.get(_b["variety"], 0) + (_b.get("bed__area") or 0)
        for _b in bed_data:
            _b["total_variety_area"] = _variety_area.get(_b.get("variety"), 0)
        spray_teams  = frappe.get_all("Spray Team", filters={"enabled": 1}, fields=["name"])

        # Per-bed zone count for the landscape view: lets the renderer draw
        # each bed as a line of its own length, producing a stepped silhouette
        # for non-rectangular greenhouses without needing GeoJSON.
        gh_beds = frappe.get_all(
            "Bed",
            filters={"greenhouse": greenhouse, "custom_active": 1},
            fields=["name"],
            limit_page_length=0,
        )
        zone_count_by_bed_global = get_or_set(
            K_ZONE_COUNT_BY_BED, build_zone_count_by_bed, ttl=TTL_SHORT
        )
        zone_count_by_bed_num = {}
        for b in gh_beds:
            m = _BED_NUM_RE.search(b.name or "")
            if not m:
                continue
            zone_count_by_bed_num[int(m.group(1))] = zone_count_by_bed_global.get(b.name, 0)

        return {
            # Latest report
            "scouting_entries": latest_entries,
            "scouting_date": date_str,
            # Previous report (may be empty list / None)
            "previous_scouting_entries": previous_entries,
            "previous_scouting_date": prev_date_str,
            # Always returned regardless of scouting data
            "susceptibility": susceptibility,
            "varieties": varieties_data,
            "boms": chemical_mix_boms,
            "bom_items": bom_items,
            "custom_bed_numbering": bed_zone_numbering[0].get("custom_bed_numbering") if bed_zone_numbering else None,
            "custom_zone_numbering": bed_zone_numbering[0].get("custom_zone_numbering") if bed_zone_numbering else None,
            "all_chemicals": all_chemicals,
            "all_fertilizers": all_fertilizers,
            "item_type_map": item_type_map,
            "bed_data": bed_data,
            "zone_count_by_bed": zone_count_by_bed_num,
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