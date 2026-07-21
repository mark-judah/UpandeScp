"""One-shot populator for Crop Scouted severity thresholds.

Run via:
    bench --site <your-site> execute upande_scp.serverscripts.scouting.populate_severity_defaults.run

Sets sensible default low/moderate/high thresholds on Pest Filter and Disease
Filter rows for the Rose and Avocado Crop Scouted records. Idempotent — only
writes a value when the existing field is empty or zero, so admin overrides
won't be clobbered if the script is run twice.
"""

import frappe


# Pest defaults — counts per warehouse (greenhouse / block) per scouting visit.
# Picked to match the dashboard's prior hardcoded `>5` = moderate / `>15` = high
# heuristic, with `>0` as the Low entry so "any sighting" still flags. Tune on
# the Crop Scouted form once you have ground-truth data.
ROSE_PEST_DEFAULTS = {
    "Thrips":            {"unit": "Per Warehouse", "low": 5,  "moderate": 15, "high": 30},
    "FCM":               {"unit": "Per Warehouse", "low": 1,  "moderate": 3,  "high": 6},
    "Helicoverpa":       {"unit": "Per Warehouse", "low": 1,  "moderate": 3,  "high": 6},
    "Duponchella":       {"unit": "Per Warehouse", "low": 1,  "moderate": 3,  "high": 6},
    "Spodoptera":        {"unit": "Per Warehouse", "low": 1,  "moderate": 3,  "high": 6},
    "Unidentified Moth": {"unit": "Per Warehouse", "low": 1,  "moderate": 3,  "high": 6},
    "Aphids":            {"unit": "Per Warehouse", "low": 5,  "moderate": 15, "high": 30},
    "Whiteflies":        {"unit": "Per Warehouse", "low": 5,  "moderate": 15, "high": 30},
    "Spidermites":       {"unit": "Per Warehouse", "low": 5,  "moderate": 15, "high": 30},
    "Mealybugs":         {"unit": "Per Warehouse", "low": 3,  "moderate": 8,  "high": 16},
    "Scale Insects":     {"unit": "Per Warehouse", "low": 3,  "moderate": 8,  "high": 16},
    "Weevils":           {"unit": "Per Warehouse", "low": 2,  "moderate": 5,  "high": 10},
}

ROSE_DISEASE_DEFAULTS = {
    "Downy Mildew":   {"unit": "Per Warehouse", "low": 1, "moderate": 3, "high": 6},
    "Powdery Mildew": {"unit": "Per Warehouse", "low": 1, "moderate": 3, "high": 6},
    "Bacterial Wilt": {"unit": "Per Warehouse", "low": 1, "moderate": 3, "high": 6},
    "Agrobacterium":  {"unit": "Per Warehouse", "low": 1, "moderate": 3, "high": 6},
    "Botrytis":       {"unit": "Per Warehouse", "low": 1, "moderate": 3, "high": 6},
    "Rust":           {"unit": "Per Warehouse", "low": 1, "moderate": 3, "high": 6},
}

# Avocado is block-based (orchards), so per-hectare thresholds line up better
# with how field scouting reports counts. Numbers are placeholders; revisit
# with the agronomy team.
AVOCADO_PEST_DEFAULTS = {
    "FCM":               {"unit": "Per Hectare", "low": 1, "moderate": 3,  "high": 6},
    "Helicoverpa":       {"unit": "Per Hectare", "low": 1, "moderate": 3,  "high": 6},
    "Spodoptera":        {"unit": "Per Hectare", "low": 1, "moderate": 3,  "high": 6},
    "Thrips":            {"unit": "Per Hectare", "low": 5, "moderate": 15, "high": 30},
    "Mealybugs":         {"unit": "Per Hectare", "low": 3, "moderate": 8,  "high": 16},
}

AVOCADO_DISEASE_DEFAULTS = {
    "Anthracnose":  {"unit": "Per Hectare", "low": 1, "moderate": 3, "high": 6},
    "Phytophthora": {"unit": "Per Hectare", "low": 1, "moderate": 3, "high": 6},
}


def _apply_defaults(crop_doc, child_field, key_field, defaults):
    """Fill empty threshold fields on `crop_doc.<child_field>` rows.

    Only touches rows whose `key_field` matches an entry in `defaults`. A
    field is treated as empty if it's None, "", or 0 — so a row already
    customised by an admin (e.g. high=42) is left alone.
    """
    written = 0
    rows = getattr(crop_doc, child_field, []) or []
    for row in rows:
        key = (getattr(row, key_field, "") or "").strip()
        spec = defaults.get(key)
        if not spec:
            continue
        if not (row.unit or "").strip():
            row.unit = spec["unit"]
            written += 1
        if not row.low_threshold:
            row.low_threshold = spec["low"]
            written += 1
        if not row.moderate_threshold:
            row.moderate_threshold = spec["moderate"]
            written += 1
        if not row.high_threshold:
            row.high_threshold = spec["high"]
            written += 1
    return written


def _populate_one(crop_name, pests, diseases):
    if not frappe.db.exists("Crop Scouted", crop_name):
        print(f"[skip] Crop Scouted '{crop_name}' not found")
        return
    doc = frappe.get_doc("Crop Scouted", crop_name)
    n_pests = _apply_defaults(doc, "pests", "pest", pests)
    n_dis = _apply_defaults(doc, "diseases", "disease", diseases)
    if n_pests or n_dis:
        doc.save(ignore_permissions=True)
        frappe.db.commit()
    print(f"[{crop_name}] pest writes: {n_pests}  disease writes: {n_dis}")


def run():
    """Bench-callable entrypoint."""
    _populate_one("Rose", ROSE_PEST_DEFAULTS, ROSE_DISEASE_DEFAULTS)
    _populate_one("Avocado", AVOCADO_PEST_DEFAULTS, AVOCADO_DISEASE_DEFAULTS)
