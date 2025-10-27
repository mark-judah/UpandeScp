import frappe

@frappe.whitelist()
def getObservationsDetails():
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
        fields=["name", "disorder_name", "photo", "description"],
        order_by="idx"
    )

    weeds = frappe.get_all(
        "Weed",
        fields=["name", "name1"],
        order_by="idx"
    )

    incidents = frappe.get_all(
        "Incident",
        fields=["name", "name1"],
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

    pest_stages = {}
    if pest_names:
        stages_data = frappe.get_all(
            "Pests Stages",
            filters={"parent": ["in", pest_names]},
            fields=["parent", "stage", "idx"],
            order_by="parent, idx"
        )
        for stage in stages_data:
            if stage.parent not in pest_stages:
                pest_stages[stage.parent] = []
            pest_stages[stage.parent].append(stage.stage)

    disease_stages = {}
    if disease_names:
        stages_data = frappe.get_all(
            "Disease Stages",
            filters={"parent": ["in", disease_names]},
            fields=["parent", "stage", "idx"],
            order_by="parent, idx"
        )
        for stage in stages_data:
            if stage.parent not in disease_stages:
                disease_stages[stage.parent] = []
            disease_stages[stage.parent].append(stage.stage)

    predator_stages = {}
    if predator_names:
        stages_data = frappe.get_all(
            "Predator Stages",
            filters={"parent": ["in", predator_names]},
            fields=["parent", "stage", "idx"],
            order_by="parent, idx"
        )
        for stage in stages_data:
            if stage.parent not in predator_stages:
                predator_stages[stage.parent] = []
            predator_stages[stage.parent].append(stage.stage)

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

    observation_types = [
        {
            "category": "Pests",
            "type": "count",
            "fields": [
                {
                    "name": pest.common_name,
                    "stages": pest_stages.get(pest.name, []),
                    "isCountable": True,
                    "isToggable": False,
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
                    "isCountable": True,
                    "isToggable": False
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
                    "isToggable": True,
                    "photo": disorder.photo,
                    "description": disorder.description
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
                    "isToggable": True
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
                    "isToggable": True
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
                    "isCountable": True,
                    "isToggable": False,
                    "targetPests": predator_targets.get(predator.name, [])
                }
                for predator in predators
            ]
        }
    ]

    frappe.response["message"] = {
        "data": observation_types
    }

    return frappe.response["message"]