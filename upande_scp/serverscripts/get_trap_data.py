# upande_scp/serverscripts/get_trap_data.py

import frappe
from frappe import _
from datetime import datetime, timedelta
import json

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
        frappe.logger().error(f"Error fetching trap data: {str(e)}")
        frappe.throw(_("Failed to fetch trap data: {0}").format(str(e)))