import frappe

# Maps a category key -> (filter doctype, link field, field linking to the crop).
# Pest Filter / Disease Filter are standalone DocTypes linked via `crop_scouted`;
# the other four are still child tables of Crop Scouted, linked via `parent`.
_CROP_FILTER_MAP = {
    "pests":                   ("Pest Filter",                   "pest",                   "crop_scouted"),
    "diseases":                ("Disease Filter",                "disease",                "crop_scouted"),
    "predators":               ("Predator Filter",               "predator",               "parent"),
    "weeds":                   ("Weed Filter",                   "weed",                   "parent"),
    "incidents":               ("Incident Filter",               "incident",               "parent"),
    "physiological_disorders": ("Physiological Disorder Filter", "physiological_disorder", "parent"),
}


def _allowed_names(crop, category):
    """Return the list of allowed master names for a category under the given crop.

    None  => no crop supplied; caller should not filter.
    []    => crop supplied but category is empty for this crop; caller should skip.
    [..]  => crop supplied and category is populated; caller should filter.
    """
    if not crop:
        return None
    filter_doctype, link_field, crop_field = _CROP_FILTER_MAP[category]
    return frappe.get_all(
        filter_doctype,
        filters={crop_field: crop},
        pluck=link_field,
    )


def _in_filter(allowed):
    """Build a name-in filter dict, or empty dict when allowed is None."""
    return {"name": ["in", allowed]} if allowed is not None else {}


@frappe.whitelist()
def getObservationsDetails(crop=None):
    # Validate crop exists; otherwise fall back to unfiltered for backwards compat.
    if crop and not frappe.db.exists("Crop Scouted", crop):
        frappe.log_error(
            message=f"Unknown Crop Scouted '{crop}', serving unfiltered observations",
            title="getObservationsDetails",
        )
        crop = None

    allowed = {cat: _allowed_names(crop, cat) for cat in _CROP_FILTER_MAP}

    # Fetch masters, skipping categories the crop has explicitly emptied.
    pests = [] if allowed["pests"] == [] else frappe.get_all(
        "Pest",
        filters=_in_filter(allowed["pests"]),
        fields=["name", "common_name"],
        order_by="idx",
    )

    diseases = [] if allowed["diseases"] == [] else frappe.get_all(
        "Plant Disease",
        filters=_in_filter(allowed["diseases"]),
        fields=["name", "common_name"],
        order_by="idx",
    )

    disorders = [] if allowed["physiological_disorders"] == [] else frappe.get_all(
        "Physiological Disorder",
        filters=_in_filter(allowed["physiological_disorders"]),
        fields=["name", "disorder_name", "photo", "reading_type", "plant_sections"],
        order_by="idx",
    )

    weeds = [] if allowed["weeds"] == [] else frappe.get_all(
        "Weed",
        filters=_in_filter(allowed["weeds"]),
        fields=["name", "name1", "reading_type", "plant_sections"],
        order_by="idx",
    )

    incidents = [] if allowed["incidents"] == [] else frappe.get_all(
        "Incident",
        filters=_in_filter(allowed["incidents"]),
        fields=["name", "name1", "reading_type", "plant_sections"],
        order_by="idx",
    )

    predators = [] if allowed["predators"] == [] else frappe.get_all(
        "Predator",
        filters=_in_filter(allowed["predators"]),
        fields=["name", "common_name"],
        order_by="idx",
    )

    pest_names = [p.name for p in pests]
    disease_names = [d.name for d in diseases]
    predator_names = [p.name for p in predators]

    # Fetch pest stages with reading_type and plant_sections for EACH stage.
    # Stages now live on Pest Filter rows per crop. When `crop` is supplied
    # we pull stages from that crop's filter rows only; otherwise we
    # aggregate across all crops, deduplicated by (pest, stage).
    pest_stages = {}
    if pest_names:
        filter_row_filters = {
            "pest": ["in", pest_names],
        }
        if crop:
            filter_row_filters["crop_scouted"] = crop
        filter_rows = frappe.get_all(
            "Pest Filter",
            filters=filter_row_filters,
            fields=["name", "pest"],
            limit_page_length=0,
        )
        row_to_pest = {r.name: r.pest for r in filter_rows}
        if row_to_pest:
            stages_data = frappe.get_all(
                "Pests Stages",
                filters={
                    "parent": ["in", list(row_to_pest.keys())],
                    "parenttype": "Pest Filter",
                },
                fields=["parent", "stage", "reading_type", "plant_sections", "idx"],
                order_by="parent, idx",
                limit_page_length=0,
            )
            seen_pest_stage = set()
            for stage in stages_data:
                pest_name = row_to_pest.get(stage.parent)
                if not pest_name:
                    continue
                key = (pest_name, stage.stage)
                if key in seen_pest_stage:
                    continue
                seen_pest_stage.add(key)
                pest_stages.setdefault(pest_name, []).append({
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

    # Plant sections allowed for this crop (empty on the crop → no filter → None).
    allowed_plant_sections = None
    if crop:
        tagged = frappe.get_all(
            "Plant Section Filter",
            filters={"parent": crop},
            pluck="plant_section",
        )
        if tagged:
            allowed_plant_sections = [s.lower() for s in tagged]

    frappe.response["message"] = {
        "data": observation_types,
        "allowed_plant_sections": allowed_plant_sections,
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