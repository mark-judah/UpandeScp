import frappe

@frappe.whitelist()
def getObservationsDetails():
    # Fetch all entities
    pests = frappe.get_all(
        "Pest",
        fields=["name", "common_name"],
        order_by="idx"
    )

    diseases = frappe.get_all(
        "Plant Disease",
        fields=["name", "common_name"],
        order_by="idx"
    )

    disorders = frappe.get_all(
        "Physiological Disorder",
        fields=["name", "disorder_name", "photo", "description", "reading_type", "range_min", "range_max"],
        order_by="idx"
    )

    weeds = frappe.get_all(
        "Weed",
        fields=["name", "name1", "reading_type", "range_min", "range_max"],
        order_by="idx"
    )

    incidents = frappe.get_all(
        "Incident",
        fields=["name", "name1", "reading_type", "range_min", "range_max"],
        order_by="idx"
    )

    predators = frappe.get_all(
        "Predator",
        fields=["name", "common_name"],
        order_by="idx"
    )

    pest_names = [p.name for p in pests]
    disease_names = [d.name for d in diseases]
    predator_names = [p.name for p in predators]

    # Fetch pest stages with reading_type
    pest_stages = {}
    pest_reading_types = {}
    if pest_names:
        stages_data = frappe.get_all(
            "Pests Stages",
            filters={"parent": ["in", pest_names]},
            fields=["parent", "stage", "idx"],  # Remove reading_type if field doesn't exist yet
            order_by="parent, idx"
        )
        for stage in stages_data:
            if stage.parent not in pest_stages:
                pest_stages[stage.parent] = []
                # Default to countable for pests with stages
                pest_reading_types[stage.parent] = "countable"
            pest_stages[stage.parent].append(stage.stage)
    
    # For pests without stages, default to count
    for pest in pests:
        if pest.name not in pest_reading_types:
            pest_reading_types[pest.name] = "count"

    # Fetch disease stages with reading_type
    disease_stages = {}
    disease_reading_types = {}
    if disease_names:
        stages_data = frappe.get_all(
            "Disease Stages",
            filters={"parent": ["in", disease_names]},
            fields=["parent", "stage", "idx"],  # Remove reading_type if field doesn't exist yet
            order_by="parent, idx"
        )
        for stage in stages_data:
            if stage.parent not in disease_stages:
                disease_stages[stage.parent] = []
                # Default to countable for diseases with stages
                disease_reading_types[stage.parent] = "countable"
            disease_stages[stage.parent].append(stage.stage)
    
    # For diseases without stages, default to count
    for disease in diseases:
        if disease.name not in disease_reading_types:
            disease_reading_types[disease.name] = "count"

    # Fetch predator stages with reading_type
    predator_stages = {}
    predator_reading_types = {}
    if predator_names:
        stages_data = frappe.get_all(
            "Predator Stages",
            filters={"parent": ["in", predator_names]},
            fields=["parent", "stage", "idx"],  # Remove reading_type if field doesn't exist yet
            order_by="parent, idx"
        )
        for stage in stages_data:
            if stage.parent not in predator_stages:
                predator_stages[stage.parent] = []
                # Default to countable for predators with stages
                predator_reading_types[stage.parent] = "countable"
            predator_stages[stage.parent].append(stage.stage)
    
    # For predators without stages, default to count
    for predator in predators:
        if predator.name not in predator_reading_types:
            predator_reading_types[predator.name] = "count"

    # Fetch predator targets
    predator_targets = {}
    if predator_names:
        targets_data = frappe.get_all(
            "Predator Targets",
            filters={"parent": ["in", predator_names]},
            fields=["parent", "pest", "idx"],
            order_by="parent, idx"
        )
        for target in targets_data:
            if target.parent not in predator_targets:
                predator_targets[target.parent] = []
            predator_targets[target.parent].append(target.pest)

    # Build observation types with reading_type
    observation_types = [
        {
            "category": "Pests",
            "type": "count",
            "fields": [
                {
                    "name": pest.common_name,
                    "stages": pest_stages.get(pest.name, []),
                    "isCountable": True,  # Always true for pests
                    "isToggable": False,
                    "readingType": pest_reading_types.get(pest.name, "countable" if pest_stages.get(pest.name) else "count"),
                }
                for pest in pests
            ]
        },
        {
            "category": "Diseases",
            "type": "count",
            "fields": [
                {
                    "name": disease.common_name,
                    "stages": disease_stages.get(disease.name, []),
                    "isCountable": True,  # Always true for diseases
                    "isToggable": False,
                    "readingType": disease_reading_types.get(disease.name, "countable" if disease_stages.get(disease.name) else "count"),
                }
                for disease in diseases
            ]
        },
        {
            "category": "Physiological Disorders",
            "type": "toggle",
            "fields": [
                {
                    "name": disorder.disorder_name,
                    "stages": None,
                    "isCountable": False,
                    "isToggable": True,  # Default to checkbox for disorders
                    "photo": disorder.photo,
                    "description": disorder.description,
                    "readingType": "checkbox",  # Default to checkbox
                    "rangeMin": None,
                    "rangeMax": None,
                }
                for disorder in disorders
            ]
        },
        {
            "category": "Weeds",
            "type": "toggle",
            "fields": [
                {
                    "name": weed.name1,
                    "stages": None,
                    "isCountable": False,
                    "isToggable": True,  # Default to checkbox for weeds
                    "readingType": "checkbox",  # Default to checkbox
                    "rangeMin": None,
                    "rangeMax": None,
                }
                for weed in weeds
            ]
        },
        {
            "category": "Incidents",
            "type": "toggle",
            "fields": [
                {
                    "name": incident.name1,
                    "stages": None,
                    "isCountable": False,
                    "isToggable": True,  # Default to checkbox for incidents
                    "readingType": "checkbox",  # Default to checkbox
                    "rangeMin": None,
                    "rangeMax": None,
                }
                for incident in incidents
            ]
        },
        {
            "category": "Predators",
            "type": "count",
            "fields": [
                {
                    "name": predator.common_name,
                    "stages": predator_stages.get(predator.name, []),
                    "isCountable": True,  # Always true for predators
                    "isToggable": False,
                    "targetPests": predator_targets.get(predator.name, []),
                    "readingType": predator_reading_types.get(predator.name, "countable" if predator_stages.get(predator.name) else "count"),
                }
                for predator in predators
            ]
        }
    ]

    frappe.response["message"] = {
        "data": observation_types
    }

    return frappe.response["message"]