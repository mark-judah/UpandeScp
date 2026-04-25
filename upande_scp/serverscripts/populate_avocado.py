"""Idempotent Avocado data populate for the Lokitela orchard.

Creates Pests, Crop Scouted (Avocado) with its Pest Filter rows, and Trap
records under each existing Lokitela block. Safe to re-run: every step
checks for an existing record before inserting and only fills in missing
pieces in the right dependency order.

Run on local mimic site:
    bench --site SITENAME execute upande_scp.serverscripts.populate_avocado.run

Run on the production "main site" (same command, different --site).

Dry-run (no DB writes, returns what *would* change):
    bench --site SITENAME execute upande_scp.serverscripts.populate_avocado.run \\
        --kwargs '{"dry_run": True}'

Limit to one farm (default Lokitela):
    bench --site SITENAME execute upande_scp.serverscripts.populate_avocado.run \\
        --kwargs '{"farm": "Lokitela"}'

The Trap doctype's `type` Select field has its options expanded by
`upande_scp/doctype/trap/trap.json` to include the new lure types
(McPhail, Delta, Femtrack Lure, Crytrack Lure, CSR Trap). After deploying
this app, run `bench --site SITENAME migrate` so those Select options
become available; then run this script.
"""

from __future__ import annotations

import json
from typing import Any

import frappe


# ---------------------------------------------------------------------------
# Source-of-truth catalogues
# ---------------------------------------------------------------------------

CROP_NAME = "Avocado"

# Pests scouted on Avocado, modelled with stages where the field sheet
# distinguishes them (e.g. Mosquito Bug Adults vs Nymphs).
# Pests scouted on Avocado. Every pest carries an "Adult" stage to match
# the existing house style (see Caterpillars / Leaf Rollers / Mosquito
# Bugs / Thrips on this site). Multi-stage pests append extra stages.
AVOCADO_PESTS: list[dict[str, Any]] = [
    {
        "common_name": "Fruit fly (Ceratitis)",
        "scientific_name": "Ceratitis capitata",
        "stages": [{"stage": "Adult", "reading_type": "Count"}],
    },
    {
        "common_name": "Fruit fly (Bactocera)",
        "scientific_name": "Bactrocera dorsalis",
        "stages": [{"stage": "Adult", "reading_type": "Count"}],
    },
    {
        "common_name": "F.C.M",
        "scientific_name": "Thaumatotibia leucotreta",
        "stages": [{"stage": "Adult", "reading_type": "Count"}],
    },
    # Each scouted separately; existing site already has "Caterpillars" and
    # "Leaf Rollers" so we reuse those names and only add "Loopers".
    {
        "common_name": "Loopers",
        "scientific_name": "",
        "stages": [{"stage": "Adult", "reading_type": "Count"}],
    },
    {
        "common_name": "Caterpillars",
        "scientific_name": "",
        "stages": [{"stage": "Adult", "reading_type": "Count"}],
    },
    {
        "common_name": "Leaf Rollers",
        "scientific_name": "",
        "stages": [{"stage": "Adult", "reading_type": "Count"}],
    },
    # Existing site already has these — reuse rather than create dupes.
    {
        "common_name": "Mosquito Bugs",
        "scientific_name": "Helopeltis spp.",
        "stages": [
            {"stage": "Adult", "reading_type": "Count"},
            {"stage": "Nymph", "reading_type": "Count"},
        ],
    },
    {
        "common_name": "Scale Insects",
        "scientific_name": "Coccoidea",
        "stages": [
            {
                "stage": "Adult",
                "reading_type": "Count",
                "plant_sections": "Fruit\nLeaves & Stems",
            },
            {"stage": "Crawler", "reading_type": "Count"},
        ],
    },
    {
        "common_name": "CSR",
        "scientific_name": "",
        "stages": [{"stage": "Adult", "reading_type": "Count"}],
    },
]

# Lure / trap types we need on the Trap doctype's `type` Select field.
TRAP_TYPES: list[str] = [
    "General",
    "FCM",
    "McPhail",
    "Delta",
    "Femtrack Lure",
    "Crytrack Lure",
    "CSR Trap",
]

# When seeding Trap records under a block, place one of each pest-relevant
# trap. trap_number gets the block name appended at insert time so
# autoname (`{farm} - {trap_number}`) stays unique. Edit freely later.
TRAPS_PER_BLOCK: list[dict[str, str]] = [
    {"suffix": "MCP", "type": "McPhail", "location": "Outdoor"},
    {"suffix": "DLT", "type": "Delta", "location": "Outdoor"},
    {"suffix": "FEM", "type": "Femtrack Lure", "location": "Outdoor"},
    {"suffix": "CRY", "type": "Crytrack Lure", "location": "Outdoor"},
    {"suffix": "CSR", "type": "CSR Trap", "location": "Outdoor"},
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _log(log: list[str], msg: str) -> None:
    print(msg)
    log.append(msg)


def _ensure_pest(pest_def: dict[str, Any], dry_run: bool, log: list[str]) -> str:
    name = pest_def["common_name"]
    if frappe.db.exists("Pest", name):
        _log(log, f"  pest exists: {name}")
        return name
    if dry_run:
        _log(log, f"  [dry-run] would create pest: {name}")
        return name
    doc = frappe.new_doc("Pest")
    doc.common_name = name
    doc.scientific_name = pest_def.get("scientific_name") or ""
    for stage in pest_def.get("stages") or []:
        doc.append(
            "stages",
            {
                "stage": stage.get("stage") or "",
                "reading_type": stage.get("reading_type") or "Count",
                "plant_sections": stage.get("plant_sections") or "",
            },
        )
    doc.insert(ignore_permissions=True)
    _log(log, f"  + created pest: {name}")
    return name


def _ensure_crop_scouted(
    crop_name: str,
    pest_names: list[str],
    farm: str | None,
    dry_run: bool,
    log: list[str],
) -> None:
    """Create Crop Scouted record and ensure each pest filter row exists."""
    if frappe.db.exists("Crop Scouted", crop_name):
        _log(log, f"  crop scouted exists: {crop_name}")
        if dry_run:
            return
        doc = frappe.get_doc("Crop Scouted", crop_name)
    else:
        if dry_run:
            _log(log, f"  [dry-run] would create crop scouted: {crop_name}")
            return
        doc = frappe.new_doc("Crop Scouted")
        doc.crop_name = crop_name
        doc.insert(ignore_permissions=True)
        _log(log, f"  + created crop scouted: {crop_name}")

    # Reload to mutate
    doc = frappe.get_doc("Crop Scouted", crop_name)

    # Ensure farm filter row (skip if no farm filter table or already present)
    if farm and frappe.db.exists("Farm", farm):
        existing_farms = {row.farm for row in (doc.farms or [])}
        if farm not in existing_farms:
            if dry_run:
                _log(log, f"  [dry-run] would link farm: {farm}")
            else:
                doc.append("farms", {"farm": farm})
                _log(log, f"  + linked farm: {farm}")

    # Ensure pest filter rows
    existing_pests = {row.pest for row in (doc.pests or [])}
    added = 0
    for pest_name in pest_names:
        if pest_name in existing_pests:
            continue
        if dry_run:
            _log(log, f"  [dry-run] would add pest filter: {pest_name}")
        else:
            doc.append("pests", {"pest": pest_name})
            added += 1
    if added > 0 and not dry_run:
        doc.save(ignore_permissions=True)
        _log(log, f"  + saved Crop Scouted with {added} new pest filter row(s)")


def _ensure_traps_for_blocks(
    farm: str, dry_run: bool, log: list[str]
) -> None:
    """Create one of each TRAPS_PER_BLOCK type under each Lokitela block."""
    blocks = frappe.get_all(
        "Warehouse",
        filters={
            "custom_farm": farm,
            "warehouse_type": "Block",
            "is_group": 0,
            "disabled": 0,
        },
        fields=["name", "warehouse_name"],
    )
    if not blocks:
        _log(log, f"  no blocks under farm '{farm}' — skipping trap seeding")
        return

    for block in blocks:
        for spec in TRAPS_PER_BLOCK:
            # Autoname format on Trap: `{farm} - {trap_number}`. Embed the
            # block name + type suffix into trap_number so names stay
            # readable and unique per (block, type).
            trap_number = f"{block.warehouse_name} {spec['suffix']}"
            full_name = f"{farm} - {trap_number}"
            if frappe.db.exists("Trap", full_name):
                continue
            if dry_run:
                _log(log, f"  [dry-run] would create trap: {full_name} → block {block.name}")
                continue
            try:
                doc = frappe.new_doc("Trap")
                doc.farm = farm
                doc.greenhouse = block.name
                doc.trap_number = trap_number
                doc.location = spec.get("location") or "Outdoor"
                doc.type = spec["type"]
                doc.insert(ignore_permissions=True)
                _log(log, f"  + created trap: {doc.name} (type {spec['type']}) → block {block.name}")
            except Exception as e:
                _log(log, f"  ! failed to create trap '{full_name}': {e}")


def _check_trap_type_options(log: list[str]) -> None:
    """Warn if the Trap doctype's `type` Select doesn't yet include the new lure types.

    The doctype JSON has been updated; this surfaces sites that need
    `bench migrate` before traps can be created.
    """
    meta = frappe.get_meta("Trap")
    type_field = meta.get_field("type")
    if not type_field or type_field.fieldtype != "Select":
        _log(log, "  !! Trap.type is not a Select field — skipping option check")
        return
    options = {opt.strip() for opt in (type_field.options or "").split("\n") if opt.strip()}
    missing = [t for t in TRAP_TYPES if t not in options]
    if missing:
        _log(
            log,
            f"  !! Trap.type Select is missing: {missing}. "
            f"Run `bench --site <site> migrate` first.",
        )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


@frappe.whitelist()
def run(dry_run: bool = False, farm: str = "Lokitela") -> dict[str, Any]:
    """Idempotently populate Avocado pest + trap data.

    Args:
        dry_run: If True, no DB writes happen — returned log shows what would change.
        farm: Farm name to seed traps under (default "Lokitela").

    Returns:
        dict with {dry_run, farm, log, summary}.
    """
    if isinstance(dry_run, str):
        dry_run = dry_run.lower() in ("1", "true", "yes")

    log: list[str] = []
    _log(log, f"== populate_avocado.run dry_run={dry_run} farm={farm} ==")

    _log(log, "[1/4] checking Trap.type Select options")
    _check_trap_type_options(log)

    _log(log, "[2/4] ensuring Pest records")
    pest_names: list[str] = []
    for pest_def in AVOCADO_PESTS:
        pest_names.append(_ensure_pest(pest_def, dry_run, log))

    _log(log, f"[3/4] ensuring Crop Scouted '{CROP_NAME}' with {len(pest_names)} pest filters")
    _ensure_crop_scouted(CROP_NAME, pest_names, farm, dry_run, log)

    _log(log, f"[4/4] ensuring Trap records under each block of farm '{farm}'")
    _ensure_traps_for_blocks(farm, dry_run, log)

    if not dry_run:
        frappe.db.commit()
        _log(log, "== committed ==")
    else:
        _log(log, "== dry-run done (no writes) ==")

    return {
        "dry_run": dry_run,
        "farm": farm,
        "summary": {
            "pests": len(pest_names),
            "crop_scouted": CROP_NAME,
        },
        "log": log,
    }


if __name__ == "__main__":  # pragma: no cover
    # Allow `python populate_avocado.py` as a smoke-test inside the bench shell.
    print(json.dumps(run(dry_run=True), indent=2, default=str))
