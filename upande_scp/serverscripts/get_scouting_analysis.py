import frappe
from frappe.utils import time_diff_in_seconds

@frappe.whitelist()
def getScoutingAnalysis():
    try:
        date_str = frappe.form_dict.get("date")

        if not date_str:
            frappe.throw("The date is required.")

        greenhouse = frappe.form_dict.get("greenhouse") or ""

        # Build filters
        se_filters = [["date_of_capture", "=", date_str]]
        if greenhouse:
            se_filters.append(["greenhouse", "=", greenhouse])

        # Fetch scouting entries for the given date (and optional greenhouse)
        scouting_entries = frappe.get_all(
            "Scouting Entry",
            fields=["name", "scouts_name", "greenhouse", "bed",
                    "zone", "time_of_capture", "date_of_capture", "latitude", "longitude", "creation"],
            filters=se_filters,
            order_by="time_of_capture asc"
        )

        # Fetch only zones referenced by these entries (avoids fetching all zones)
        entry_zones = list({e.zone for e in scouting_entries if e.zone})
        if entry_zones:
            all_zones = frappe.get_all(
                "Zone",
                filters={"name": ["in", entry_zones], "raw_geojson": ["is", "set"]},
                fields=["name", "raw_geojson"]
            )
        else:
            all_zones = []

        scouting_summary = {
            "total_unique_scouts": 0,
            "total_beds_covered": 0,
            "average_zones_per_bed": 0,
            "average_minutes_per_bed": 0
        }
        scout_movement_timeline = []
        scout_paths_list = []

        if not scouting_entries:
            return {
                "scouting_summary": scouting_summary,
                "scout_movement_timeline": [],
                "scout_paths": [],
                "all_zones_geojson": all_zones,
                "scouting_entries": []
            }
        else:
            # Map scout IDs to names
            unique_scout_ids = {entry.get("scouts_name") for entry in scouting_entries}

            employee_map = {}
            if unique_scout_ids:
                employees = frappe.get_all(
                    "Employee",
                    filters={"name": ("in", list(unique_scout_ids))},
                    fields=["name", "employee_name"]
                )
                employee_map = {emp.get("name"): emp.get("employee_name") for emp in employees}

            for entry in scouting_entries:
                scout_id = entry.get("scouts_name")
                if scout_id in employee_map:
                    entry["scouts_name"] = employee_map[scout_id]

            scout_greenhouse_sessions = {}
            for record in scouting_entries:
                scout_name = record.get("scouts_name")
                gh = record.get("greenhouse")
                time_of_capture = record.get("time_of_capture")

                if scout_name and gh and time_of_capture is not None:
                    record["time_of_capture_dt"] = time_of_capture

                    if scout_name not in scout_greenhouse_sessions:
                        scout_greenhouse_sessions[scout_name] = {}
                    if gh not in scout_greenhouse_sessions[scout_name]:
                        scout_greenhouse_sessions[scout_name][gh] = []
                    scout_greenhouse_sessions[scout_name][gh].append(record)

            overall_total_beds = 0
            overall_total_zones = 0
            overall_total_minutes = 0
            overall_unique_scouts = set()

            for scout_name, greenhouses in scout_greenhouse_sessions.items():
                overall_unique_scouts.add(scout_name)

                for greenhouse_name, entries in greenhouses.items():
                    entries.sort(key=lambda x: x['time_of_capture_dt'])

                    start_time_obj = entries[0]['time_of_capture_dt']
                    end_time_obj = entries[-1]['time_of_capture_dt']

                    session_beds = {e['bed'] for e in entries}
                    session_zones_by_bed = {bed: set() for bed in session_beds}
                    for e in entries:
                        session_zones_by_bed[e['bed']].add(e['zone'])

                    total_session_beds = len(session_beds)
                    total_session_zones = sum(len(zones) for zones in session_zones_by_bed.values())

                    time_diff_seconds = time_diff_in_seconds(end_time_obj, start_time_obj)

                    if time_diff_seconds < 0:
                        time_diff_seconds = time_diff_seconds + (24 * 3600)

                    minutes_spent = time_diff_seconds / 60

                    overall_total_beds += total_session_beds
                    overall_total_zones += total_session_zones
                    overall_total_minutes += minutes_spent

                    start_time_formatted = str(start_time_obj)
                    end_time_formatted = str(end_time_obj)

                    scout_movement_timeline.append({
                        "name": scout_name,
                        "greenhouse": greenhouse_name,
                        "start": start_time_formatted,
                        "end": end_time_formatted,
                        "beds": total_session_beds,
                        "zonesPerBed": total_session_zones / total_session_beds if total_session_beds > 0 else 0,
                        "minutesPerBed": minutes_spent / total_session_beds if total_session_beds > 0 else 0,
                    })

            scouting_summary["total_unique_scouts"] = len(overall_unique_scouts)
            scouting_summary["total_beds_covered"] = overall_total_beds
            scouting_summary["average_zones_per_bed"] = overall_total_zones / overall_total_beds if overall_total_beds > 0 else 0
            scouting_summary["average_minutes_per_bed"] = overall_total_minutes / overall_total_beds if overall_total_beds > 0 else 0

            scout_paths = {}
            for record in scouting_entries:
                scout_name = record.get("scouts_name")
                latitude = record.get("latitude")
                longitude = record.get("longitude")
                if latitude is not None and longitude is not None:
                    if scout_name not in scout_paths:
                        scout_paths[scout_name] = []
                    scout_paths[scout_name].append([latitude, longitude])

            for scout_name, path_data in scout_paths.items():
                scout_paths_list.append({
                    "name": scout_name,
                    "path": path_data
                })

            return {
                "scouting_summary": scouting_summary,
                "scout_movement_timeline": scout_movement_timeline,
                "scout_paths": scout_paths_list,
                "all_zones_geojson": all_zones,
                "scouting_entries": scouting_entries
            }

    except Exception as e:
        frappe.log_error(title="Scouting Analysis Error", message=str(e))
        frappe.throw("Error fetching scouting analysis: " + str(e))
