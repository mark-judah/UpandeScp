# upande_scp/serverscripts/get_trap_data.py

import csv
import io
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
def exportFcmCsv(week_from=None, week_to=None, greenhouse=None):
    try:
        if not week_from and not week_to:
            frappe.throw(_("Week range is required"))

        if not week_from:
            week_from = week_to
        if not week_to:
            week_to = week_from

        from_year_str, from_week_str = str(week_from).split("-W")
        to_year_str, to_week_str = str(week_to).split("-W")
        from_year = int(from_year_str)
        from_week_num = int(from_week_str)
        to_year = int(to_year_str)
        to_week_num = int(to_week_str)

        start = date.fromisocalendar(from_year, from_week_num, 1)
        end = date.fromisocalendar(to_year, to_week_num, 7)
        if start > end:
            start, end = end, start
            week_from, week_to = week_to, week_from

        start_date_str = start.strftime("%Y-%m-%d")
        end_date_str = end.strftime("%Y-%m-%d")

        fcm_trap_filters = {"type": "FCM"}
        if greenhouse:
            fcm_trap_filters["greenhouse"] = greenhouse

        fcm_traps = frappe.get_all(
            "Trap",
            filters=fcm_trap_filters,
            fields=["name", "greenhouse", "trap_number", "location", "type"],
            order_by="trap_number asc",
            limit_page_length=10000,
        )
        traps_by_name = {t["name"]: t for t in fcm_traps}

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
        trap_rows = []
        if entry_names:
            trap_rows = frappe.get_all(
                "Trap Scouting Entry",
                filters={"parent": ["in", entry_names], "parenttype": "Scouting Entry"},
                fields=["parent", "trap", "pest", "location", "count"],
                limit_page_length=100000,
            )

        entries_by_name = {e["name"]: e for e in scouting_entries}

        def week_key(dt):
            d = dt if isinstance(dt, date) else datetime.strptime(str(dt), "%Y-%m-%d").date()
            iso = d.isocalendar()
            return f"{iso.year}-W{iso.week:02d}"

        def week_label(dt):
            d = dt if isinstance(dt, date) else datetime.strptime(str(dt), "%Y-%m-%d").date()
            iso = d.isocalendar()
            return f"Week {iso.week:02d}"

        def iter_weeks(from_date, to_date):
            d = from_date
            while d <= to_date:
                yield d
                d = d + timedelta(days=7)

        def day_suffix(n):
            if 11 <= (n % 100) <= 13:
                return "th"
            return {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")

        def format_human_date(d):
            return f"{d.day}{day_suffix(d.day)} {d.strftime('%b')} {d.year}"

        def classify_location(value):
            v = (value or "").strip().lower()
            if v.startswith("out") or "outdoor" in v or "exterior" in v:
                return "Outdoor"
            return "Indoor"

        def to_int(value):
            try:
                return int(float(value or 0))
            except Exception:
                return 0

        def parse_house_number(trap_number):
            try:
                n = int(str(trap_number).strip())
            except Exception:
                return None
            if n < 100:
                return None
            return n // 100

        def format_house_label(house_no):
            if not house_no:
                return ""
            return f"House {int(house_no):02d}"

        totals = {}
        for tr in trap_rows:
            pest = (tr.get("pest") or "").strip()
            if pest.upper() != "FCM":
                continue
            entry = entries_by_name.get(tr.get("parent"))
            if not entry:
                continue
            trap_name = tr.get("trap")
            trap_doc = traps_by_name.get(trap_name) if trap_name else None
            if not trap_doc:
                continue

            wk = week_key(entry.get("date_of_capture"))
            loc = classify_location(trap_doc.get("location") or tr.get("location"))
            key = (wk, trap_doc["name"], loc)
            totals[key] = totals.get(key, 0) + to_int(tr.get("count"))

        week_starts = list(iter_weeks(start, end))

        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(
            [
                "Week of the year",
                "Greenhouse No./Identity and size (Ha)",
                "Trap No.",
                "Source (supplier)  of  pheromone lure",
                "Pheromone placement date",
                "Date of count",
                "No. of FCM adults inside greenhouse",
                "Cummulative No. of eggs/larvea observed in the greenhouse",
                "No. of FCM adults outside greenhouse",
            ]
        )

        row_count = 0
        for week_start in week_starts:
            wk_key = week_key(week_start)
            wk_label = week_label(week_start)
            from_str = f"FROM: {format_human_date(week_start)}"
            to_str = f"TO: {format_human_date(week_start + timedelta(days=5))}"

            traps_sorted = sorted(
                fcm_traps,
                key=lambda t: (
                    parse_house_number(t.get("trap_number")) or 9999,
                    str(t.get("trap_number") or ""),
                ),
            )

            last_house = None
            week_row_index = 0
            for trap_doc in traps_sorted:
                trap_number = trap_doc.get("trap_number") or ""
                house_no = parse_house_number(trap_number)
                house_label = format_house_label(house_no)

                indoor_count = totals.get((wk_key, trap_doc["name"], "Indoor"), 0)
                outdoor_count = totals.get((wk_key, trap_doc["name"], "Outdoor"), 0)

                week_cell = wk_label if week_row_index == 0 else ""
                house_cell = house_label if house_no != last_house else ""
                last_house = house_no

                date_of_count = ""
                if week_row_index == 0:
                    date_of_count = from_str
                elif week_row_index == 1:
                    date_of_count = to_str

                writer.writerow(
                    [
                        week_cell,
                        house_cell,
                        trap_number,
                        "KOPPERT",
                        "",
                        date_of_count,
                        indoor_count,
                        0,
                        outdoor_count,
                    ]
                )
                row_count += 1
                week_row_index += 1
        csv_text = buffer.getvalue()

        return {
            "week_from": week_from,
            "week_to": week_to,
            "start_date": start_date_str,
            "end_date": end_date_str,
            "row_count": row_count,
            "csv": csv_text,
        }
    except Exception as e:
        frappe.logger().error(f"Error exporting FCM CSV: {e!s}")
        frappe.throw(_("Failed to export FCM CSV: {0}").format(e))
