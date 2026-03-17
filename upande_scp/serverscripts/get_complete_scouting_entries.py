import frappe


@frappe.whitelist()
def getCompleteScoutingEntries(from_date=None, to_date=None, greenhouse=None):
    try:
        from_date = from_date or frappe.form_dict.get("from_date")
        to_date = to_date or frappe.form_dict.get("to_date")
        greenhouse_filter = greenhouse or frappe.form_dict.get("greenhouse")

        if not from_date or not to_date:
            frappe.throw("from_date and to_date are required")

        entry_filters = [
            ["date_of_capture", "between", [from_date, to_date]]
        ]

        if greenhouse_filter:
            entry_filters.append(["greenhouse", "=", greenhouse_filter])

        scouting_entries = frappe.get_all(
            "Scouting Entry",
            filters=entry_filters,
            fields=[
                "name",
                "scouts_name",
                "greenhouse",
                "bed",
                "zone",
                "time_of_capture",
                "date_of_capture",
                "latitude",
                "longitude",
                "naming_series",
                "owner",
                "creation",
                "modified",
                "modified_by",
                "docstatus",
                "idx",
            ],
            order_by="date_of_capture desc, time_of_capture desc",
            limit_page_length=10000,
        )

        entry_names = [e.name for e in scouting_entries]

        if not entry_names:
            return {
                "entries": [],
                "pests": [],
                "diseases": [],
                "physiological_disorders": [],
                "weeds": [],
                "predators": [],
                "traps": [],
                "incidents": [],
            }

        pests = frappe.get_all(
            "Pests Scouting Entry",
            filters=[["parent", "in", entry_names]],
            fields=[
                "name",
                "parent",
                "parentfield",
                "parenttype",
                "idx",
                "plant_section",
                "pest",
                "stage",
                "count",
                "owner",
                "creation",
                "modified",
                "modified_by",
                "docstatus",
            ],
        )

        diseases = frappe.get_all(
            "Diseases Scouting Entry",
            filters=[["parent", "in", entry_names]],
            fields=[
                "name",
                "parent",
                "parentfield",
                "parenttype",
                "idx",
                "disease",
                "severity_level",
                "percentage_affected",
                "plant_section",
                "owner",
                "creation",
                "modified",
                "modified_by",
                "docstatus",
            ],
        )

        physiological_disorders = frappe.get_all(
            "Physiological Disorders Scouting Entry",
            filters=[["parent", "in", entry_names]],
            fields=[
                "name",
                "parent",
                "parentfield",
                "parenttype",
                "idx",
                "physiological_disorder",
                "severity_level",
                "percentage_affected",
                "plant_section",
                "owner",
                "creation",
                "modified",
                "modified_by",
                "docstatus",
            ],
        )

        weeds = frappe.get_all(
            "Weeds Scouting Entry",
            filters=[["parent", "in", entry_names]],
            fields=[
                "name",
                "parent",
                "parentfield",
                "parenttype",
                "idx",
                "weed",
                "density",
                "plant_section",
                "owner",
                "creation",
                "modified",
                "modified_by",
                "docstatus",
            ],
        )

        predators = frappe.get_all(
            "Predators Scouting Entry",
            filters=[["parent", "in", entry_names]],
            fields=[
                "name",
                "parent",
                "parentfield",
                "parenttype",
                "idx",
                "predator",
                "count",
                "plant_section",
                "owner",
                "creation",
                "modified",
                "modified_by",
                "docstatus",
            ],
        )

        traps = frappe.get_all(
            "Trap Scouting Entry",
            filters=[["parent", "in", entry_names]],
            fields=[
                "name",
                "parent",
                "parentfield",
                "parenttype",
                "idx",
                "trap_name",
                "pest",
                "count",
                "plant_section",
                "owner",
                "creation",
                "modified",
                "modified_by",
                "docstatus",
            ],
        )

        incidents = frappe.get_all(
            "Incidents Scouting Entry",
            filters=[["parent", "in", entry_names]],
            fields=[
                "name",
                "parent",
                "parentfield",
                "parenttype",
                "idx",
                "incident_type",
                "description",
                "plant_section",
                "owner",
                "creation",
                "modified",
                "modified_by",
                "docstatus",
            ],
        )

        entries_dict = {entry.name: entry for entry in scouting_entries}

        for pest in pests:
            parent = pest.pop("parent", None)
            if parent in entries_dict:
                entries_dict[parent].setdefault("pests", []).append(pest)

        for disease in diseases:
            parent = disease.pop("parent", None)
            if parent in entries_dict:
                entries_dict[parent].setdefault("diseases", []).append(disease)

        for disorder in physiological_disorders:
            parent = disorder.pop("parent", None)
            if parent in entries_dict:
                entries_dict[parent].setdefault("physiological_disorders", []).append(disorder)

        for weed in weeds:
            parent = weed.pop("parent", None)
            if parent in entries_dict:
                entries_dict[parent].setdefault("weeds", []).append(weed)

        for predator in predators:
            parent = predator.pop("parent", None)
            if parent in entries_dict:
                entries_dict[parent].setdefault("predators", []).append(predator)

        for trap in traps:
            parent = trap.pop("parent", None)
            if parent in entries_dict:
                entries_dict[parent].setdefault("traps", []).append(trap)

        for incident in incidents:
            parent = incident.pop("parent", None)
            if parent in entries_dict:
                entries_dict[parent].setdefault("incidents", []).append(incident)

        enhanced_entries = list(entries_dict.values())

        return {
            "entries": enhanced_entries,
            "pests_flat": pests,
            "diseases_flat": diseases,
            "physiological_disorders_flat": physiological_disorders,
            "weeds_flat": weeds,
            "predators_flat": predators,
            "traps_flat": traps,
            "incidents_flat": incidents,
            "total_entries": len(scouting_entries),
            "filters_applied": {
                "from_date": from_date,
                "to_date": to_date,
                "greenhouse": greenhouse_filter,
            },
        }
    except Exception as e:
        frappe.log_error(f"Error in scouting data extraction: {str(e)}", "Scouting Entry API")
        frappe.throw(str(e))
