import frappe
from frappe import _
import json

@frappe.whitelist()
def getHeatmapData(date, greenhouse):
    """
    Fetch scouting entries for a specific date and greenhouse with observation type details
    """
    try:
        # Get scouting entries for the specified date and greenhouse
        scouting_entries = frappe.get_all(
            "Scouting Entry",
            filters={
                "date_of_capture": date,
                "greenhouse": greenhouse
            },
            fields=["name", "zone", "bed", "greenhouse"]
        )
        
        # Get bed count and zone count for the greenhouse
        bed_count = frappe.db.count("Bed", filters={
            "greenhouse": greenhouse,
            "custom_active": 1
        })
        
        # Get all beds for this greenhouse to find max zone count
        beds = frappe.get_all(
            "Bed",
            filters={
                "greenhouse": greenhouse,
                "custom_active": 1
            },
            fields=["name"]
        )
        
        # Find maximum zone count across all beds
        max_zone_count = 0
        for bed in beds:
            zone_count = frappe.db.count("Zone", filters={
                "greenhouse": greenhouse,
                "bed": bed.name
            })
            max_zone_count = max(max_zone_count, zone_count)
        
        if not scouting_entries:
            return {
                "scouting_entries": [],
                "observation_types": {},
                "bed_count": bed_count,
                "zone_count": max_zone_count,
                "message": "No scouting entries found for this date and greenhouse"
            }
        
        # Fetch complete details for each entry
        detailed_entries = []
        for entry in scouting_entries:
            full_entry = frappe.get_doc("Scouting Entry", entry.name)
            
            entry_data = {
                "name": full_entry.name,
                "zone": full_entry.zone,
                "bed": full_entry.bed,
                "greenhouse": full_entry.greenhouse,
                "pests_scouting_entry": [],
                "diseases_scouting_entry": [],
                "predators_scouting_entry": [],
                "weeds_scouting_entry": [],
                "incidents_scouting_entry": [],
                "physiological_disorders_entry": []
            }
            
            # Process pests
            for pest_entry in full_entry.pests_scouting_entry:
                entry_data["pests_scouting_entry"].append({
                    "name": pest_entry.pest,
                    "stage": pest_entry.stage,
                    "count": pest_entry.count or 0,
                    "plant_section": pest_entry.plant_section
                })
            
            # Process diseases
            for disease_entry in full_entry.diseases_scouting_entry:
                entry_data["diseases_scouting_entry"].append({
                    "name": disease_entry.disease,
                    "stage": disease_entry.stage,
                    "plant_section": disease_entry.plant_section
                })
            
            # Process predators
            for predator_entry in full_entry.predators_scouting_entry:
                entry_data["predators_scouting_entry"].append({
                    "name": predator_entry.predator,
                    "stage": predator_entry.stage,
                    "count": predator_entry.count or 0,
                    "plant_section": predator_entry.plant_section
                })
            
            # Process weeds
            for weed_entry in full_entry.weeds_scouting_entry:
                entry_data["weeds_scouting_entry"].append({
                    "name": weed_entry.weed
                })
            
            # Process incidents
            for incident_entry in full_entry.incidents_scouting_entry:
                entry_data["incidents_scouting_entry"].append({
                    "name": incident_entry.incident
                })
            
            # Process physiological disorders
            for disorder_entry in full_entry.physiological_disorders_entry:
                entry_data["physiological_disorders_entry"].append({
                    "name": disorder_entry.physiological_disorders
                })
            
            detailed_entries.append(entry_data)
        
        # Fetch observation type metadata
        observation_types = {}
        
        # Get all pests with their stages and colors
        pests = frappe.get_all("Pest", fields=["name", "common_name", "pests_legend_color"])
        observation_types["pests"] = {}
        for pest in pests:
            pest_doc = frappe.get_doc("Pest", pest.name)
            observation_types["pests"][pest.common_name] = {
                "color": pest.pests_legend_color or "#999999",
                "stages": []
            }
            for stage in pest_doc.stages:
                observation_types["pests"][pest.common_name]["stages"].append({
                    "stage": stage.stage,
                    "symbol": stage.get("symbol", ""),
                    "reading_type": stage.reading_type
                })
        
        # Get all diseases with their stages and colors
        diseases = frappe.get_all("Plant Disease", fields=["name", "common_name", "disease_legend_color"])
        observation_types["diseases"] = {}
        for disease in diseases:
            disease_doc = frappe.get_doc("Plant Disease", disease.name)
            observation_types["diseases"][disease.common_name] = {
                "color": disease.disease_legend_color or "#999999",
                "stages": []
            }
            for stage in disease_doc.stages:
                observation_types["diseases"][disease.common_name]["stages"].append({
                    "stage": stage.stage,
                    "symbol": stage.get("symbol", ""),
                    "reading_type": stage.reading_type
                })
        
        # Get all predators with their stages
        predators = frappe.get_all("Predator", fields=["name", "common_name"])
        observation_types["predators"] = {}
        for predator in predators:
            predator_doc = frappe.get_doc("Predator", predator.name)
            observation_types["predators"][predator.common_name] = {
                "color": "#4c6ef5",
                "stages": []
            }
            for stage in predator_doc.predator_stages:
                observation_types["predators"][predator.common_name]["stages"].append({
                    "stage": stage.stage,
                    "symbol": "",
                    "reading_type": stage.reading_type
                })
        
        # Get all weeds
        weeds = frappe.get_all("Weed", fields=["name"])
        observation_types["weeds"] = {}
        for weed in weeds:
            observation_types["weeds"][weed.name] = {
                "color": "#51cf66",
                "stages": []
            }
        
        # Get all incidents
        incidents = frappe.get_all("Incident", fields=["name", "name"])
        observation_types["incidents"] = {}
        for incident in incidents:
            observation_types["incidents"][incident.name] = {
                "color": "#868e96",
                "stages": []
            }
        
        # Get all physiological disorders
        disorders = frappe.get_all("Physiological Disorder", fields=["name", "name"])
        observation_types["physiological_disorders"] = {}
        for disorder in disorders:
            observation_types["physiological_disorders"][disorder.name] = {
                "color": "#ff6b6b",
                "stages": []
            }
        
        return {
            "scouting_entries": detailed_entries,
            "observation_types": observation_types,
            "bed_count": bed_count,
            "zone_count": max_zone_count,
            "date": date,
            "greenhouse": greenhouse
        }
        
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Get Heatmap Data Error")
        frappe.throw(_("Error fetching heatmap data: {0}").format(str(e)))


@frappe.whitelist()
def getFarmsAndGreenhouses():
    """
    Fetch all farms and their associated greenhouses
    """
    try:
        # Get all farms
        farms = frappe.get_all(
            "Farm",
            fields=["name", "farm"],
            order_by="farm asc"
        )
        
        # Get all greenhouses (warehouses of type Greenhouse)
        greenhouses = frappe.get_all(
            "Warehouse",
            filters={
                "warehouse_type": "Greenhouse"
            },
            fields=["name", "warehouse_name", "custom_farm"],
            order_by="name asc"
        )
        
        # Group greenhouses by farm
        farms_data = {}
        for farm in farms:
            farm_name = farm.farm
            farms_data[farm_name] = {
                "name": farm_name,
                "greenhouses": []
            }
        
        # Add greenhouses to their respective farms
        for gh in greenhouses:
            farm_name = gh.custom_farm
            if farm_name and farm_name in farms_data:
                farms_data[farm_name]["greenhouses"].append({
                    "name": gh.name,
                    "warehouse_name": gh.warehouse_name
                })
        
        # Convert to list and filter out farms with no greenhouses
        result = [
            {
                "name": farm_name,
                "greenhouses": data["greenhouses"]
            }
            for farm_name, data in farms_data.items()
            if len(data["greenhouses"]) > 0
        ]
        
        return {
            "farms": result
        }
        
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "Get Farms and Greenhouses Error")
        frappe.throw(_("Error fetching farms and greenhouses: {0}").format(str(e)))