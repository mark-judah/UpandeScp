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
        fields=["name", "disorder_name", "photo", "reading_type", "plant_sections"],
        order_by="idx"
    )

    weeds = frappe.get_all(
        "Weed",
        fields=["name", "name1", "reading_type", "plant_sections"],
        order_by="idx"
    )

    incidents = frappe.get_all(
        "Incident",
        fields=["name", "name1", "reading_type", "plant_sections"],
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

    # Fetch pest stages with reading_type and plant_sections for EACH stage
    pest_stages = {}
    if pest_names:
        stages_data = frappe.get_all(
            "Pests Stages",
            filters={"parent": ["in", pest_names]},
            fields=["parent", "stage", "reading_type", "plant_sections", "idx"],
            order_by="parent, idx"
        )
        for stage in stages_data:
            if stage.parent not in pest_stages:
                pest_stages[stage.parent] = []
            pest_stages[stage.parent].append({
                "stage": stage.stage,
                "reading_type": (stage.reading_type or "Count").lower(),
                "plant_sections": _parse_plant_sections(stage.plant_sections)
            })

    # Fetch disease stages with reading_type, plant_sections, range_min, and range_max for EACH stage
    disease_stages = {}
    if disease_names:
        stages_data = frappe.get_all(
            "Disease Stages",
            filters={"parent": ["in", disease_names]},
            fields=["parent", "stage", "reading_type", "plant_sections", "range_min", "range_max", "idx"],
            order_by="parent, idx"
        )
        for stage in stages_data:
            if stage.parent not in disease_stages:
                disease_stages[stage.parent] = []
            disease_stages[stage.parent].append({
                "stage": stage.stage,
                "reading_type": (stage.reading_type or "Count").lower(),
                "plant_sections": _parse_plant_sections(stage.plant_sections),
                "range_min": _to_float(stage.range_min),
                "range_max": _to_float(stage.range_max)
            })

    # Fetch predator stages with reading_type and plant_sections for EACH stage
    predator_stages = {}
    if predator_names:
        stages_data = frappe.get_all(
            "Predator Stages",
            filters={"parent": ["in", predator_names]},
            fields=["parent", "stage", "reading_type", "plant_sections", "idx"],
            order_by="parent, idx"
        )
        for stage in stages_data:
            if stage.parent not in predator_stages:
                predator_stages[stage.parent] = []
            predator_stages[stage.parent].append({
                "stage": stage.stage,
                "reading_type": (stage.reading_type or "Count").lower(),
                "plant_sections": _parse_plant_sections(stage.plant_sections)
            })

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

    # Build observation types - each stage is a separate field now
    observation_types = []

    # PESTS - Create a field for each stage
    pest_fields = []
    for pest in pests:
        stages = pest_stages.get(pest.name, [])
        for stage_info in stages:
            pest_fields.append({
                "pestName": pest.common_name,
                "stage": stage_info['stage'],
                "readingType": stage_info['reading_type'],
                "plantSections": stage_info['plant_sections'],
                "stages": None
            })
    
    if pest_fields:
        observation_types.append({
            "category": "Pests",
            "type": "mixed",
            "fields": pest_fields
        })

    # DISEASES - Create a field for each stage with range_min and range_max
    disease_fields = []
    for disease in diseases:
        stages = disease_stages.get(disease.name, [])
        for stage_info in stages:
            disease_fields.append({
                "diseaseName": disease.common_name,
                "stage": stage_info['stage'],
                "readingType": stage_info['reading_type'],
                "plantSections": stage_info['plant_sections'],
                "rangeMin": stage_info['range_min'],
                "rangeMax": stage_info['range_max'],
                "stages": None
            })
    
    if disease_fields:
        observation_types.append({
            "category": "Diseases",
            "type": "mixed",
            "fields": disease_fields
        })

    # PHYSIOLOGICAL DISORDERS - Single field per disorder (no range)
    if disorders:
        observation_types.append({
            "category": "Physiological Disorders",
            "type": "toggle",
            "fields": [
                {
                    "name": disorder.disorder_name,
                    "stage": None,
                    "stages": None,
                    "photo": disorder.photo,
                    "readingType": (disorder.reading_type or "Checkbox").lower(),
                    "plantSections": _parse_plant_sections(disorder.plant_sections),
                }
                for disorder in disorders
            ]
        })

    # WEEDS - Single field per weed (no range)
    if weeds:
        observation_types.append({
            "category": "Weeds",
            "type": "toggle",
            "fields": [
                {
                    "name": weed.name1,
                    "stage": None,
                    "stages": None,
                    "readingType": (weed.reading_type or "Checkbox").lower(),
                    "plantSections": _parse_plant_sections(weed.plant_sections),
                }
                for weed in weeds
            ]
        })

    # INCIDENTS - Single field per incident (no range)
    if incidents:
        observation_types.append({
            "category": "Incidents",
            "type": "toggle",
            "fields": [
                {
                    "name": incident.name1,
                    "stage": None,
                    "stages": None,
                    "readingType": (incident.reading_type or "Checkbox").lower(),
                    "plantSections": _parse_plant_sections(incident.plant_sections),
                }
                for incident in incidents
            ]
        })

    # PREDATORS - Create a field for each stage
    predator_fields = []
    for predator in predators:
        stages = predator_stages.get(predator.name, [])
        for stage_info in stages:
            predator_fields.append({
                "predatorName": predator.common_name,
                "stage": stage_info['stage'],
                "readingType": stage_info['reading_type'],
                "plantSections": stage_info['plant_sections'],
                "stages": None,
                "targetPests": predator_targets.get(predator.name, [])
            })
    
    if predator_fields:
        observation_types.append({
            "category": "Predators",
            "type": "mixed",
            "fields": predator_fields
        })

    frappe.response["message"] = {
        "data": observation_types
    }

    return frappe.response["message"]


def _parse_plant_sections(plant_sections_str):
    """
    Parse plant_sections string into a list of lowercase plant part names.
    Handles formats like: "Buds", "Buds, Base", "Buds\nBase", etc.
    Returns None if empty/null, meaning all plant parts are applicable.
    """
    if not plant_sections_str:
        return None
    
    # Split by comma or newline, strip whitespace, convert to lowercase
    sections = [s.strip().lower() for s in plant_sections_str.replace('\n', ',').split(',')]
    sections = [s for s in sections if s]  # Remove empty strings
    
    return sections if sections else None


def _to_float(value):
    """
    Convert a value to float, handling None and string inputs.
    Returns None if the value is None or cannot be converted.
    """
    if value is None:
        return None
    
    try:
        return float(value)
    except (ValueError, TypeError):
        return None