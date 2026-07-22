"""Observation colour resolver.

Storage lives on the Pest and Plant Disease doctypes — `pests_legend_color`
and `disease_legend_color`. This module:

  - exposes a tiny whitelisted endpoint the SPA calls once on boot, so the
    same map drives every legend, marker, and badge;
  - holds the canonical defaults the system was specced with so a fresh
    install / new pest gets a sensible colour without manual seeding.

The cache invalidation hooks live in cache_utils.py — editing a Pest or
Plant Disease doc busts ``K_PEST_COLORS`` / ``K_DISEASE_COLORS`` so the
next call rebuilds the map.
"""

import frappe

from upande_scp.serverscripts.scouting.get_complete_scouting_entries import (
    _cached_disease_colors,
    _cached_pest_colors,
)


# Canonical colour map. Used both for first-time seeding (see
# ``seed_canonical_colors``) and as a fallback in ``get_observation_colors``
# when a doc exists but its colour field is empty. Keep keys aligned with
# the doc ``name`` (autoname is ``common_name``), but match case-insensitively
# at lookup time so naming-rule drift doesn't silently lose a pest.
PEST_DEFAULTS = {
    "FCM": "#dc2626",            # Red
    "Helicoverpa": "#eab308",    # Yellow
    "Spodoptera": "#f97316",     # Orange
    "Duponchelia": "#38bdf8",    # Sky Blue
    "Duponchella": "#38bdf8",    # alt spelling encountered in production data
    "Thrips": "#2563eb",         # Blue
    "Spidermites": "#8b4513",    # Brown
    "Spider Mite": "#8b4513",
    "Spider Mites": "#8b4513",
    "Aphids": "#16a34a",         # Green
    "White Flies": "#6b7280",    # Grey
    "Whitefly": "#6b7280",
    "Mealybugs": "#d4a017",      # Gold
    "Mealybug": "#d4a017",
    # Moth observations seen in raw data but not formally listed —
    # share Spodoptera's moth-orange family so the marker remains readable.
    "Unidentified Moth": "#fb923c",
    # --- multi-crop expansion (Rose / Avocado / Coffee) ---
    "Scale Insects": "#78716b",
    "Weevils": "#57534e",
    "Caterpillars": "#84cc16",
    "Coconut Bug": "#b45309",
    "Fruit fly (Bactocera)": "#0891b2",
    "Fruit fly (Ceratitis)": "#0e7490",
    "Leaf Rollers": "#65a30d",
    "Loopers": "#4d7c0f",
    "Mosquito Bugs": "#be123c",
    "Stinkbug": "#15803d",
    "Unidentified Insects": "#9ca3af",
    # Coffee pests
    "Antestia Bug": "#7c3aed",
    "Capsid Bug": "#db2777",
    "Lace Bug": "#0d9488",
    "Leaf Skeletonizer": "#ca8a04",
    "Leaf Miner": "#a16207",
    "Tailed Caterpillar": "#22c55e",
    "Systates Weevil": "#78350f",
    "Kenya Mealybug": "#facc15",
    "Brown Scale": "#92400e",
    "Yellow Termites": "#fde047",
    "Green Scale": "#4ade80",
    "Coffee Thrips": "#1d4ed8",
    "Berry Moth": "#e11d48",
    "Berry Borer": "#831843",
    "Sting Caterpillar": "#a3e635",
}

DISEASE_DEFAULTS = {
    "Powdery Mildew": "#166534",  # Dark Green
    "Downy Mildew": "#ec4899",    # Pink
    "Botrytis": "#a855f7",        # Purple
    "Botyrtis": "#a855f7",        # alt spelling encountered in production data
    "Agrobacteria": "#eab308",    # Yellow
    "Agrobacterium": "#eab308",
    "Rust": "#c8a165",            # Tan
    # --- multi-crop expansion (Rose / Avocado / Coffee) ---
    "Bacterial Wilt": "#b91c1c",
    # Coffee diseases
    "Coffee Berry Disease": "#7f1d1d",
    "Coffee Leaf Rust": "#ea580c",
    "Coffee Wilt (Fusarium)": "#713f12",
    "Brown Eye Spot": "#a16207",
    "Bacterial Blight of Coffee": "#1e3a8a",
    # Avocado diseases
    "Anthracnose": "#292524",
    "Cercospora Spot": "#6d28d9",
    "Phytophthora Root Rot": "#365314",
    "Avocado Scab": "#9a3412",
}


def _normalize(s):
    return (s or "").strip().lower()


def _canonical_pest_color(name):
    key = _normalize(name)
    for k, v in PEST_DEFAULTS.items():
        if _normalize(k) == key:
            return v
    return None


def _canonical_disease_color(name):
    key = _normalize(name)
    for k, v in DISEASE_DEFAULTS.items():
        if _normalize(k) == key:
            return v
    return None


@frappe.whitelist(allow_guest=False)
def get_observation_colors():
    """Return ``{pests: {name: hex}, diseases: {name: hex}}``.

    Doctype-stored colour wins; if a doc has the field blank, the canonical
    default fills in so legends never render grey for a known pest.
    """
    pests = {}
    for row in _cached_pest_colors() or []:
        name = row.get("name")
        if not name:
            continue
        hex_value = row.get("pests_legend_color") or _canonical_pest_color(name)
        if hex_value:
            pests[name] = hex_value

    diseases = {}
    for row in _cached_disease_colors() or []:
        name = row.get("name")
        if not name:
            continue
        hex_value = row.get("disease_legend_color") or _canonical_disease_color(name)
        if hex_value:
            diseases[name] = hex_value

    return {"pests": pests, "diseases": diseases}


@frappe.whitelist()
def seed_canonical_colors(force=False):
    """Idempotently populate the canonical colour for every Pest /
    Plant Disease record listed in the defaults above.

    By default only fills empty colour fields so operator overrides are
    preserved; pass ``force=1`` to overwrite every value.
    """
    force_flag = str(force).lower() in ("1", "true", "yes")
    updated = {"pests": [], "diseases": []}

    for name, hex_value in PEST_DEFAULTS.items():
        if not frappe.db.exists("Pest", name):
            continue
        current = frappe.db.get_value("Pest", name, "pests_legend_color")
        if current and not force_flag:
            continue
        frappe.db.set_value("Pest", name, "pests_legend_color", hex_value)
        updated["pests"].append(name)

    for name, hex_value in DISEASE_DEFAULTS.items():
        if not frappe.db.exists("Plant Disease", name):
            continue
        current = frappe.db.get_value("Plant Disease", name, "disease_legend_color")
        if current and not force_flag:
            continue
        frappe.db.set_value("Plant Disease", name, "disease_legend_color", hex_value)
        updated["diseases"].append(name)

    if updated["pests"] or updated["diseases"]:
        frappe.cache().delete_value("scouting_dashboard:pest_colors")
        frappe.cache().delete_value("scouting_dashboard:disease_colors")
        frappe.db.commit()

    return updated


def after_migrate():
    """Hook target — run automatically on ``bench migrate`` so a fresh
    deployment never renders a known pest in fallback grey.
    """
    try:
        seed_canonical_colors()
    except Exception:
        # Don't fail the migration over a colour seed.
        frappe.logger().exception("upande_scp: observation_colors.after_migrate failed")
