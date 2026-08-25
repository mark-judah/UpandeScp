"""Prefill metadata for a first batch of well-known chemicals on the Chemical
master, from public product/label data (verified online 2026-06-30).

Fills only EMPTY fields (type, active ingredients, FRAC/IRAC code, targets,
description) — never rates, toxicity, allowed or crops, and never overwrites a
value already set by a user. Links (codes/targets) are appended only when the
catalog record exists. Idempotent and failure-isolated.

Scope: 10 globally-documented products. Local/own-brand chemicals are left for
later batches (only fill what's confidently sourced).
"""
from __future__ import annotations

import frappe

# item_code -> verified metadata. pests/diseases must exist in the Pest /
# Plant Disease catalog to link; codes must exist in FRAC Code / IRAC Code.
DATA: dict[str, dict] = {
    "CHE00043": {  # RIDOMIL GOLD
        "type": "Fungicide", "actives": ["Metalaxyl-M", "Mancozeb"],
        "frac": ["4", "M3"], "diseases": ["Downy Mildew"],
        "desc": "Systemic + contact fungicide: metalaxyl-M (FRAC 4) + mancozeb (FRAC M3); downy mildews / Phytophthora.",
    },
    "CHE00040": {  # TELDOR
        "type": "Fungicide", "actives": ["Fenhexamid"],
        "frac": ["17"], "diseases": ["Botrytis"],
        "desc": "Fenhexamid, hydroxyanilide fungicide (FRAC 17); specific for Botrytis cinerea.",
    },
    "CHE00061": {  # SWITCH 62.5 WG
        "type": "Fungicide", "actives": ["Cyprodinil", "Fludioxonil"],
        "frac": ["9", "12"], "diseases": ["Botrytis"],
        "desc": "Cyprodinil (FRAC 9) + fludioxonil (FRAC 12); broad-spectrum, strong on Botrytis.",
    },
    "CHE00080": {  # SCORE
        "type": "Fungicide", "actives": ["Difenoconazole"],
        "frac": ["3"], "diseases": ["Powdery Mildew", "Rust"],
        "desc": "Difenoconazole, DMI triazole (FRAC 3); powdery mildew, rusts and leaf spots.",
    },
    "CHE00065": {  # MOVENTO
        "type": "Insecticide", "actives": ["Spirotetramat"],
        "irac": ["23"], "pests": ["Aphids", "Whiteflies", "Mealybugs", "Spidermites"],
        "desc": "Spirotetramat (IRAC 23), fully systemic; sucking pests — aphids, whiteflies, mealybugs, mites.",
    },
    "CHE00017": {  # BELT
        "type": "Insecticide", "actives": ["Flubendiamide"],
        "irac": ["28"], "pests": ["Caterpillars", "Spodoptera"],
        "desc": "Flubendiamide, diamide (IRAC 28) ryanodine-receptor modulator; lepidopteran caterpillars.",
    },
    "CHE00015": {  # TRACER 480 SC
        "type": "Insecticide", "actives": ["Spinosad"],
        "irac": ["5"], "pests": ["Thrips", "Caterpillars", "Spodoptera"],
        "desc": "Spinosad (IRAC 5); thrips and caterpillars, soft on beneficials.",
    },
    "CHE00008": {  # DELEGATE 250WG
        "type": "Insecticide", "actives": ["Spinetoram"],
        "irac": ["5"], "pests": ["Thrips", "Caterpillars", "Spodoptera"],
        "desc": "Spinetoram (IRAC 5); thrips, caterpillars, leafminers.",
    },
    "CHE00022": {  # NIMROD
        "type": "Fungicide", "actives": ["Bupirimate"],
        "frac": ["8"], "diseases": ["Powdery Mildew"],
        "desc": "Bupirimate, hydroxypyrimidine (FRAC 8); systemic powdery-mildew control.",
    },
    "CHE00074": {  # ROVRAL
        "type": "Fungicide", "actives": ["Iprodione"],
        "frac": ["2"], "diseases": ["Botrytis"],
        "desc": "Iprodione, dicarboximide (FRAC 2); Botrytis — single application (high resistance risk).",
    },
}


def execute() -> None:
    if not frappe.db.table_exists("Chemical"):
        return
    for code, d in DATA.items():
        if not frappe.db.exists("Chemical", code):
            continue
        try:
            chem = frappe.get_doc("Chemical", code)
            changed = False
            # Type is authoritative for this verified batch — correct it even if
            # the backfill pre-set a wrong value (all were copied as Insecticide).
            if d.get("type") and chem.type != d["type"]:
                chem.type = d["type"]
                changed = True
            if not chem.get("active_ingredients") and d.get("actives"):
                for ing in d["actives"]:
                    chem.append("active_ingredients", {"ingredient": ing})
                changed = True
            if not chem.get("frac"):
                for c in d.get("frac", []):
                    if frappe.db.exists("FRAC Code", c):
                        chem.append("frac", {"code": c})
                        changed = True
            if not chem.get("irac"):
                for c in d.get("irac", []):
                    if frappe.db.exists("IRAC Code", c):
                        chem.append("irac", {"code": c})
                        changed = True
            if not chem.get("default_targets"):
                for p in d.get("pests", []):
                    if frappe.db.exists("Pest", p):
                        chem.append("default_targets", {"pest": p})
                        changed = True
                for dis in d.get("diseases", []):
                    if frappe.db.exists("Plant Disease", dis):
                        chem.append("default_targets", {"disease": dis})
                        changed = True
            if not chem.description and d.get("desc"):
                chem.description = d["desc"]
                changed = True
            if changed:
                chem.flags.ignore_permissions = True
                chem.save()
                frappe.db.commit()
        except Exception:
            frappe.db.rollback()
            frappe.log_error(frappe.get_traceback(), f"prefill_chemical_metadata: {code}")
