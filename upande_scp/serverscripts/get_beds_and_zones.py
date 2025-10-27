import frappe

@frappe.whitelist()
def getBedsAndZones():
    try:
        beds = frappe.get_all("Bed", fields=["name", "variety"])
        zones = frappe.get_all(
            "Zone",
            filters={"raw_geojson": ["is", "set"]},
            fields=["name", "raw_geojson", "bed"] 
        )

        bed_map = {b["name"]: {**b, "zones": []} for b in beds}
        for z in zones:
            if z["bed"] in bed_map:
                bed_map[z["bed"]]["zones"].append({
                    "name": z["name"],
                    "raw_geojson": z["raw_geojson"],
                })

        variety_map = {}
        for bed in bed_map.values():
            variety = bed["variety"]
            if variety not in variety_map:
                variety_map[variety] = {"variety": variety, "beds": []}
            
            if bed["zones"]:
                variety_map[variety]["beds"].append({
                    "name": bed["name"],
                    "zones": bed["zones"]
                })

        frappe.response["data"] = list(variety_map.values())

    except Exception as e:
        frappe.log_error(title="getBedsAndZones Error", message=str(e))
        frappe.throw("Error fetching map data. Please check server logs for details.")