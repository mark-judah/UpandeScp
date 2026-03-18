# upande_scp/serverscripts/get_trap_data.py

import csv
import io
import json
from datetime import date, datetime, timedelta

import frappe
from frappe import _


@frappe.whitelist()
def getTrapData(week):
    """
    Fetch trap monitoring data for a specific week
    Week format: 2025-W45 (year-week)
    """
    try:
        # Parse week string (e.g., "2025-W45")
        year, week_num = week.split('-W')
        year = int(year)
        week_num = int(week_num)

        # Calculate start and end dates of the week
        # Week starts on Monday
        jan_first = datetime(year, 1, 1)
        # Find the Monday of week 1
        days_to_monday = (7 - jan_first.weekday()) % 7
        if days_to_monday == 0 and jan_first.weekday() != 0:
            days_to_monday = 7
        week_one_monday = jan_first + timedelta(days=days_to_monday)

        # Calculate the Monday of the requested week
        start_date = week_one_monday + timedelta(weeks=week_num - 1)
        end_date = start_date + timedelta(days=6)  # Sunday

        start_date_str = start_date.strftime('%Y-%m-%d')
        end_date_str = end_date.strftime('%Y-%m-%d')

        frappe.logger().info(f"Fetching trap data for week {week}: {start_date_str} to {end_date_str}")

        # Fetch all scouting entries with trap data in the date range
        scouting_entries = frappe.get_all(
            'Scouting Entry',
            filters={
                'date_of_capture': ['between', [start_date_str, end_date_str]],
                'docstatus': ['!=', 2]  # Not cancelled
            },
            fields=[
                'name',
                'greenhouse',
                'bed',
                'zone',
                'date_of_capture',
                'time_of_capture',
                'latitude',
                'longitude'
            ]
        )

        # Fetch trap entries for these scouting entries
        trap_entries = []
        greenhouses_set = set()
        pests_set = set()

        for entry in scouting_entries:
            traps = frappe.get_all(
                'Trap Scouting Entry',
                filters={
                    'parent': entry.name,
                    'parenttype': 'Scouting Entry'
                },
                fields=[
                    'trap',
                    'pest',
                    'location',
                    'count'
                ]
            )

            for trap in traps:
                # Extract greenhouse name (first part before ' - ')
                greenhouse = entry.greenhouse.split(' - ')[0] if entry.greenhouse else 'Unknown'
                greenhouses_set.add(greenhouse)
                pests_set.add(trap.pest)

                trap_entries.append({
                    'scouting_entry': entry.name,
                    'trap': trap.trap,
                    'pest': trap.pest,
                    'location': trap.location,
                    'count': trap.count or 0,
                    'greenhouse': entry.greenhouse,
                    'bed': entry.bed,
                    'zone': entry.zone,
                    'date_of_capture': entry.date_of_capture,
                    'time_of_capture': entry.time_of_capture,
                    'latitude': entry.latitude,
                    'longitude': entry.longitude
                })

        # Fetch zone GeoJSON data
        zones_with_geojson = frappe.get_all(
            'Zone',
            filters={'raw_geojson': ['!=', '']},
            fields=['name', 'raw_geojson']
        )

        frappe.logger().info(f"Found {len(trap_entries)} trap entries for week {week}")

        return {
            'trap_entries': trap_entries,
            'greenhouses': sorted(list(greenhouses_set)),
            'pests': sorted(list(pests_set)),
            'all_zones_geojson': zones_with_geojson,
            'week': week,
            'start_date': start_date_str,
            'end_date': end_date_str,
            'total_traps': len(trap_entries)
        }

    except Exception as e:
        frappe.logger().error(f"Error fetching trap data: {e!s}")
        frappe.throw(_("Failed to fetch trap data: {0}").format(e))


@frappe.whitelist()
def exportFcmCsv(week, greenhouse=None):
    try:
        if not week:
            frappe.throw(_("Week is required"))

        year_str, week_str = str(week).split("-W")
        year = int(year_str)
        week_num = int(week_str)

        start = date.fromisocalendar(year, week_num, 1)
        end = start + timedelta(days=6)
        start_date_str = start.strftime("%Y-%m-%d")
        end_date_str = end.strftime("%Y-%m-%d")

        entry_filters = {
            "date_of_capture": ["between", [start_date_str, end_date_str]],
            "docstatus": ["!=", 2],
        }
        if greenhouse:
            entry_filters["greenhouse"] = greenhouse

        scouting_entries = frappe.get_all(
            "Scouting Entry",
            filters=entry_filters,
            fields=["name", "greenhouse", "bed", "zone", "date_of_capture", "scouts_name"],
            limit_page_length=10000,
        )

        entry_names = [e["name"] for e in scouting_entries]
        if not entry_names:
            return {
                "week": week,
                "start_date": start_date_str,
                "end_date": end_date_str,
                "row_count": 0,
                "csv": "House,Greenhouse,Week,Date,Trap,Location,Count,Bed,Zone,Scout,Scouting Entry\n",
                "file_path": "/home/sudouser/code/frappe/v15/apps/upande_scp/data.txt",
            }

        trap_rows = frappe.get_all(
            "Trap Scouting Entry",
            filters={"parent": ["in", entry_names], "parenttype": "Scouting Entry"},
            fields=["parent", "trap", "pest", "location", "count"],
            limit_page_length=100000,
        )

        entries_by_name = {e["name"]: e for e in scouting_entries}

        def normalize_greenhouse(value):
            gh = (value or "").strip()
            if " - " in gh:
                gh = gh.split(" - ")[0].strip()
            return gh

        data_rows = []
        greenhouses = set()
        for tr in trap_rows:
            pest = (tr.get("pest") or "").strip()
            if pest.upper() != "FCM":
                continue
            entry = entries_by_name.get(tr.get("parent"))
            if not entry:
                continue
            gh = normalize_greenhouse(entry.get("greenhouse"))
            greenhouses.add(gh)
            data_rows.append(
                {
                    "greenhouse": gh,
                    "week": week,
                    "date": entry.get("date_of_capture") or "",
                    "trap": tr.get("trap") or "",
                    "location": tr.get("location") or "",
                    "count": tr.get("count") or 0,
                    "bed": entry.get("bed") or "",
                    "zone": entry.get("zone") or "",
                    "scout": entry.get("scouts_name") or "",
                    "scouting_entry": entry.get("name") or "",
                }
            )

        greenhouse_list = sorted(
            greenhouses,
            key=lambda s: (str(s).strip().lower() != "chepsito greenhouse 1", str(s).strip().lower()),
        )
        house_map = {gh: i + 1 for i, gh in enumerate(greenhouse_list)}

        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(
            ["House", "Greenhouse", "Week", "Date", "Trap", "Location", "Count", "Bed", "Zone", "Scout", "Scouting Entry"]
        )
        for r in data_rows:
            writer.writerow(
                [
                    house_map.get(r["greenhouse"], ""),
                    r["greenhouse"],
                    r["week"],
                    r["date"],
                    r["trap"],
                    r["location"],
                    r["count"],
                    r["bed"],
                    r["zone"],
                    r["scout"],
                    r["scouting_entry"],
                ]
            )
        csv_text = buffer.getvalue()

        file_path = "/home/sudouser/code/frappe/v15/apps/upande_scp/data.txt"
        with open(file_path, "w", encoding="utf-8", newline="") as f:
            f.write(csv_text)

        return {
            "week": week,
            "start_date": start_date_str,
            "end_date": end_date_str,
            "row_count": len(data_rows),
            "csv": csv_text,
            "file_path": file_path,
        }
    except Exception as e:
        frappe.logger().error(f"Error exporting FCM CSV: {e!s}")
        frappe.throw(_("Failed to export FCM CSV: {0}").format(e))
