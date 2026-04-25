"""Idempotent Avocado data populate for the Lokitela orchard.

What this script does, in order:

  1. Reloads the doctype JSONs that changed for the per-crop stages refactor
     (`Pest`, `Pest Filter`, `Crop Scouted`). This is the same work that
     `bench migrate` would do, but isolated to just our changes — useful
     when migrate is blocked by an unrelated data issue elsewhere.
  2. Runs the `Pest.stages → Pest Filter.stages` migration patch (idempotent),
     so existing crops keep their stages after the schema move.
  3. Ensures the Avocado-related Pest master records exist (no stages — those
     now live per-crop on Pest Filter).
  4. Reconciles the Avocado `Crop Scouted` record's Pest Filter rows with
     the desired pest list and per-row stages, removing pests no longer
     scouted on Avocado (e.g. CSR).
  5. Seeds one of each `TRAPS_PER_BLOCK` trap type under every Lokitela block.

Safe to re-run. All steps check before they write.

NOTE — code-level changes (the new whitelisted `pest_filter_api`, the
`crop_scouted.js` dialog editor, `cache_utils`/`get_scouting_report`/
`mobile/get_observations_details` queries, the `hooks.py` cache invalidator,
the updated `getPestsData` server-script fixture) ship with the app code,
not via this populate script. Deploy the app, then run this.

Run on local mimic site:
    bench --site SITENAME execute upande_scp.serverscripts.populate_avocado.run

Run on the production "main site" (same command, different --site).

Dry-run (no DB writes, returns what *would* change):
    bench --site SITENAME execute upande_scp.serverscripts.populate_avocado.run \\
        --kwargs '{"dry_run": True}'

Limit to one farm (default Lokitela):
    bench --site SITENAME execute upande_scp.serverscripts.populate_avocado.run \\
        --kwargs '{"farm": "Lokitela"}'

Skip schema reload + migration patch (e.g. if you've already run migrate):
    bench --site SITENAME execute upande_scp.serverscripts.populate_avocado.run \\
        --kwargs '{"skip_schema": True}'

The Trap doctype's `type` Select field has its options expanded by
`upande_scp/doctype/trap/trap.json` to include the new lure types
(McPhail, Delta, Femtrack Lure, Crytrack Lure, CSR Trap). The schema
reload step pulls in those options too.
"""

from __future__ import annotations

import json
from typing import Any

import frappe


# ---------------------------------------------------------------------------
# Source-of-truth catalogues
# ---------------------------------------------------------------------------

CROP_NAME = "Avocado"

# Pests scouted on Avocado, with their per-crop stages and recording types.
# Stages now live on the Pest Filter row (Crop Scouted → pests child table),
# so updating the list here only affects Avocado — Rose etc. keep their own.
AVOCADO_PESTS: list[dict[str, Any]] = [
    {
        "common_name": "F.C.M",
        "scientific_name": "Thaumatotibia leucotreta",
        "stages": [
            {"stage": "Adult", "reading_type": "Count"},
            {"stage": "Damages", "reading_type": "Count"},
        ],
    },
    {
        "common_name": "Loopers",
        "scientific_name": "",
        "stages": [
            {"stage": "Adult", "reading_type": "Count"},
            {"stage": "Damages", "reading_type": "Count"},
            {"stage": "Eggs", "reading_type": "Count"},
        ],
    },
    {
        "common_name": "Caterpillars",
        "scientific_name": "",
        "stages": [
            {"stage": "Adult", "reading_type": "Count"},
            {"stage": "Larvae", "reading_type": "Count"},
            {"stage": "Damages", "reading_type": "Count"},
        ],
    },
    {
        "common_name": "Leaf Rollers",
        "scientific_name": "",
        "stages": [
            {"stage": "Adult", "reading_type": "Count"},
            {"stage": "Damages", "reading_type": "Count"},
        ],
    },
    {
        "common_name": "Mosquito Bugs",
        "scientific_name": "Helopeltis spp.",
        "stages": [
            {"stage": "Adult", "reading_type": "Count"},
            {"stage": "Nymph", "reading_type": "Count"},
            {"stage": "Damages", "reading_type": "Count"},
        ],
    },
    {
        "common_name": "Fruit Fly",
        "scientific_name": "",
        "stages": [
            {"stage": "Adult", "reading_type": "Count"},
            {"stage": "Damages", "reading_type": "Count"},
        ],
    },
    {
        "common_name": "Scale Insects",
        "scientific_name": "Coccoidea",
        "stages": [
            {"stage": "Adult", "reading_type": "Count"},
            {"stage": "Crawler", "reading_type": "Count"},
        ],
    },
    {
        "common_name": "Stinkbug",
        "scientific_name": "",
        "stages": [
            {"stage": "Adult", "reading_type": "Count"},
            {"stage": "Damages", "reading_type": "Count"},
        ],
    },
    {
        "common_name": "Coconut Bug",
        "scientific_name": "Pseudotheraptus wayi",
        "stages": [
            {"stage": "Adult", "reading_type": "Count"},
            {"stage": "Damages", "reading_type": "Count"},
        ],
    },
    {
        "common_name": "Mealybugs",
        "scientific_name": "",
        "stages": [
            {"stage": "Adult", "reading_type": "Count"},
            {"stage": "Larvae", "reading_type": "Count"},
        ],
    },
    # Already on the Avocado Crop Scouted; refresh their stages too.
    {
        "common_name": "Fruit fly (Ceratitis)",
        "scientific_name": "Ceratitis capitata",
        "stages": [
            {"stage": "Adult", "reading_type": "Count"},
            {"stage": "Damages", "reading_type": "Count"},
        ],
    },
    {
        "common_name": "Fruit fly (Bactocera)",
        "scientific_name": "Bactrocera dorsalis",
        "stages": [
            {"stage": "Adult", "reading_type": "Count"},
            {"stage": "Damages", "reading_type": "Count"},
        ],
    },
    {
        "common_name": "Unidentified Insects",
        "scientific_name": "",
        "stages": [
            {"stage": "Adult", "reading_type": "Count"},
            {"stage": "Damages", "reading_type": "Count"},
        ],
    },
]

# Pests to unlink from the Avocado Crop Scouted's pests filter table.
# The Pest master is left in place so other crops are untouched.
AVOCADO_PESTS_TO_REMOVE: list[str] = ["CSR"]

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
    """Ensure the Pest master record exists. Stages are NOT set here — they
    live per-crop on Pest Filter rows now.
    """
    name = pest_def["common_name"]
    scientific_name = pest_def.get("scientific_name") or ""

    if frappe.db.exists("Pest", name):
        if scientific_name and not frappe.db.get_value("Pest", name, "scientific_name"):
            if dry_run:
                _log(log, f"  [dry-run] would set scientific_name on {name}: {scientific_name}")
            else:
                frappe.db.set_value("Pest", name, "scientific_name", scientific_name)
                _log(log, f"  ~ set scientific_name on {name}: {scientific_name}")
        else:
            _log(log, f"  pest exists: {name}")
        return name

    if dry_run:
        _log(log, f"  [dry-run] would create pest: {name}")
        return name
    doc = frappe.new_doc("Pest")
    doc.common_name = name
    doc.scientific_name = scientific_name
    doc.insert(ignore_permissions=True)
    _log(log, f"  + created pest: {name}")
    return name


def _current_stages_for_filter_row(filter_row_name: str) -> list[tuple[str, str]]:
    rows = frappe.get_all(
        "Pests Stages",
        filters={"parent": filter_row_name, "parenttype": "Pest Filter"},
        fields=["stage", "reading_type"],
        order_by="idx",
    )
    return [(r.stage or "", (r.reading_type or "Count")) for r in rows]


def _stages_match_db(filter_row_name: str, desired_stages: list[dict[str, Any]]) -> bool:
    current = _current_stages_for_filter_row(filter_row_name)
    target = [(s["stage"], s.get("reading_type") or "Count") for s in desired_stages]
    return current == target


def _replace_pest_filter_stages(
    filter_row_name: str, desired_stages: list[dict[str, Any]]
) -> None:
    """Replace the Pests Stages rows under a Pest Filter row.

    Frappe's parent.save() doesn't cascade into grandchildren, so we manage
    Pests Stages directly. Idempotent: deletes existing rows under this
    filter row before inserting the new ones.
    """
    frappe.db.delete(
        "Pests Stages",
        {"parent": filter_row_name, "parenttype": "Pest Filter"},
    )
    for idx, stage_def in enumerate(desired_stages, start=1):
        ps = frappe.new_doc("Pests Stages")
        ps.parent = filter_row_name
        ps.parenttype = "Pest Filter"
        ps.parentfield = "stages"
        ps.idx = idx
        ps.stage = stage_def["stage"]
        ps.reading_type = stage_def.get("reading_type") or "Count"
        ps.plant_sections = stage_def.get("plant_sections") or ""
        ps.db_insert()


def _ensure_crop_scouted(
    crop_name: str,
    pest_specs: list[dict[str, Any]],
    pests_to_remove: list[str],
    farm: str | None,
    dry_run: bool,
    log: list[str],
) -> None:
    """Reconcile the Avocado Crop Scouted record's pests filter table.

    For each spec: ensure a Pest Filter row exists for that pest with the
    desired stages. Removes any rows in `pests_to_remove`.
    """
    if frappe.db.exists("Crop Scouted", crop_name):
        _log(log, f"  crop scouted exists: {crop_name}")
        if dry_run:
            doc = frappe.get_doc("Crop Scouted", crop_name)
        else:
            doc = frappe.get_doc("Crop Scouted", crop_name)
    else:
        if dry_run:
            _log(log, f"  [dry-run] would create crop scouted: {crop_name}")
            return
        doc = frappe.new_doc("Crop Scouted")
        doc.crop_name = crop_name
        doc.insert(ignore_permissions=True)
        _log(log, f"  + created crop scouted: {crop_name}")
        doc = frappe.get_doc("Crop Scouted", crop_name)

    # ── Farm filter ─────────────────────────────────────────────────────
    if farm and frappe.db.exists("Farm", farm):
        existing_farms = {row.farm for row in (doc.farms or [])}
        if farm not in existing_farms:
            if dry_run:
                _log(log, f"  [dry-run] would link farm: {farm}")
            else:
                doc.append("farms", {"farm": farm})
                _log(log, f"  + linked farm: {farm}")

    # ── Remove unwanted pest filter rows ───────────────────────────────
    if pests_to_remove:
        remove_set = set(pests_to_remove)
        original_rows = list(doc.pests or [])
        rows_to_drop = [r for r in original_rows if r.pest in remove_set]
        if rows_to_drop:
            if dry_run:
                _log(log, f"  [dry-run] would remove pest filter rows: {[r.pest for r in rows_to_drop]}")
            else:
                # Drop their stages first, then rebuild doc.pests without them.
                for r in rows_to_drop:
                    frappe.db.delete(
                        "Pests Stages",
                        {"parent": r.name, "parenttype": "Pest Filter"},
                    )
                kept = [r for r in original_rows if r.pest not in remove_set]
                doc.set("pests", [])
                for r in kept:
                    doc.append("pests", {"pest": r.pest})
                _log(log, f"  - removed pest filter rows: {[r.pest for r in rows_to_drop]}")

    # ── Add any missing Pest Filter rows (no stages yet — set after save) ─
    rows_by_pest = {row.pest: row for row in (doc.pests or [])}
    pests_needing_addition = []
    for spec in pest_specs:
        pest_name = spec["common_name"]
        if pest_name not in rows_by_pest:
            if dry_run:
                _log(log, f"  [dry-run] would add pest filter {pest_name} with stages {[s['stage'] for s in spec['stages']]}")
            else:
                doc.append("pests", {"pest": pest_name})
                pests_needing_addition.append(pest_name)

    if not dry_run:
        doc.save(ignore_permissions=True)
        _log(log, f"  + saved Crop Scouted '{crop_name}'")
        # Re-load so any newly-appended rows have their assigned names.
        doc = frappe.get_doc("Crop Scouted", crop_name)
        rows_by_pest = {row.pest: row for row in (doc.pests or [])}

    # ── Reconcile stages on each Pest Filter row (separate cascade) ────
    for spec in pest_specs:
        pest_name = spec["common_name"]
        desired = spec["stages"]
        row = rows_by_pest.get(pest_name)
        if not row:
            # Dry-run path: row wasn't actually added.
            continue
        if _stages_match_db(row.name, desired):
            _log(log, f"  stages up-to-date: {pest_name}")
            continue
        if dry_run:
            _log(log, f"  [dry-run] would set stages for {pest_name}: {[s['stage'] for s in desired]}")
            continue
        _replace_pest_filter_stages(row.name, desired)
        verb = "added" if pest_name in pests_needing_addition else "updated"
        _log(log, f"  ~ {verb} stages for {pest_name}: {[s['stage'] for s in desired]}")


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
    """Warn if the Trap doctype's `type` Select doesn't yet include the new lure types."""
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


def _check_pest_filter_has_stages(log: list[str]) -> bool:
    """Confirm the Pest Filter doctype has the new `stages` table field.

    Returns False (and warns) if the site hasn't migrated to the per-crop
    stage schema yet — the script still runs the pest creation step but
    skips the Crop Scouted reconciliation.
    """
    meta = frappe.get_meta("Pest Filter", cached=False)
    if not meta.get_field("stages"):
        _log(
            log,
            "  !! Pest Filter doctype is missing the `stages` table — "
            "run `bench --site <site> migrate` first.",
        )
        return False
    return True


# Doctypes whose JSON changed for the per-crop stages refactor. Reloading
# them syncs DocField records and the underlying SQL columns from the JSON
# in the upande_scp app — the same work `bench migrate` would do for the
# DocType step, but scoped to just what we changed.
_DOCTYPES_TO_RELOAD: list[tuple[str, str]] = [
    ("upande_scp", "pest_filter"),
    ("upande_scp", "pest"),
    ("upande_scp", "crop_scouted"),
]

_PEST_STAGES_PATCH = "upande_scp.patches.v1_0.migrate_pest_stages_to_pest_filter"


def _reload_changed_doctypes(dry_run: bool, log: list[str]) -> None:
    """Reload the doctypes touched by the per-crop stages refactor."""
    for module, dt in _DOCTYPES_TO_RELOAD:
        if dry_run:
            _log(log, f"  [dry-run] would reload doctype: {dt}")
            continue
        try:
            frappe.reload_doc(module, "doctype", dt, force=True)
            _log(log, f"  ~ reloaded doctype: {dt}")
        except Exception as e:
            _log(log, f"  ! failed to reload doctype '{dt}': {e}")
    if not dry_run:
        frappe.clear_cache()


def _run_pest_stages_patch(dry_run: bool, log: list[str]) -> None:
    """Run the Pest.stages → Pest Filter.stages migration if not already done.

    The patch is idempotent — it skips Pest Filter rows that already have
    stages — but we also gate on the Patch Log so re-runs don't re-import
    the module unnecessarily.
    """
    already_run = frappe.db.exists("Patch Log", {"patch": _PEST_STAGES_PATCH})
    if already_run:
        _log(log, f"  patch already executed: {_PEST_STAGES_PATCH}")
        return
    if dry_run:
        _log(log, f"  [dry-run] would execute patch: {_PEST_STAGES_PATCH}")
        return
    try:
        from upande_scp.patches.v1_0 import migrate_pest_stages_to_pest_filter
        migrate_pest_stages_to_pest_filter.execute()
        # Record it in Patch Log so future `bench migrate` skips it.
        pl = frappe.new_doc("Patch Log")
        pl.patch = _PEST_STAGES_PATCH
        pl.insert(ignore_permissions=True)
        frappe.db.commit()
        _log(log, f"  + executed patch: {_PEST_STAGES_PATCH}")
    except Exception as e:
        _log(log, f"  ! patch '{_PEST_STAGES_PATCH}' failed: {e}")
        raise


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


@frappe.whitelist()
def run(
    dry_run: bool = False,
    farm: str = "Lokitela",
    skip_schema: bool = False,
) -> dict[str, Any]:
    """Idempotently populate Avocado pest + trap data.

    Args:
        dry_run: If True, no DB writes happen — returned log shows what would change.
        farm: Farm name to seed traps under (default "Lokitela").
        skip_schema: If True, skip the doctype reload + migration patch steps
            (use when `bench migrate` has already been run successfully).

    Returns:
        dict with {dry_run, farm, log, summary}.
    """
    if isinstance(dry_run, str):
        dry_run = dry_run.lower() in ("1", "true", "yes")
    if isinstance(skip_schema, str):
        skip_schema = skip_schema.lower() in ("1", "true", "yes")

    log: list[str] = []
    _log(
        log,
        f"== populate_avocado.run dry_run={dry_run} farm={farm} "
        f"skip_schema={skip_schema} ==",
    )

    if skip_schema:
        _log(log, "[1/7] SKIPPED doctype reload (skip_schema=True)")
        _log(log, "[2/7] SKIPPED pest stages migration patch (skip_schema=True)")
    else:
        _log(log, "[1/7] reloading changed doctypes (Pest, Pest Filter, Crop Scouted)")
        _reload_changed_doctypes(dry_run, log)

        _log(log, "[2/7] running Pest.stages → Pest Filter.stages migration patch")
        _run_pest_stages_patch(dry_run, log)

    _log(log, "[3/7] checking Trap.type Select options")
    _check_trap_type_options(log)

    _log(log, "[4/7] checking Pest Filter has per-crop stages table")
    has_per_crop_stages = _check_pest_filter_has_stages(log)

    _log(log, "[5/7] ensuring Pest master records (no stages — those are per-crop now)")
    pest_names: list[str] = []
    for pest_def in AVOCADO_PESTS:
        pest_names.append(_ensure_pest(pest_def, dry_run, log))

    if has_per_crop_stages:
        _log(
            log,
            f"[6/7] reconciling Crop Scouted '{CROP_NAME}' "
            f"({len(pest_names)} pests, removing {AVOCADO_PESTS_TO_REMOVE})",
        )
        _ensure_crop_scouted(
            CROP_NAME,
            AVOCADO_PESTS,
            AVOCADO_PESTS_TO_REMOVE,
            farm,
            dry_run,
            log,
        )
    else:
        _log(log, "[6/7] SKIPPED Crop Scouted reconciliation — schema not ready")

    _log(log, f"[7/7] ensuring Trap records under each block of farm '{farm}'")
    _ensure_traps_for_blocks(farm, dry_run, log)

    if not dry_run:
        frappe.db.commit()
        _log(log, "== committed ==")
    else:
        _log(log, "== dry-run done (no writes) ==")

    return {
        "dry_run": dry_run,
        "farm": farm,
        "skip_schema": skip_schema,
        "summary": {
            "pests": len(pest_names),
            "crop_scouted": CROP_NAME,
            "removed_pests": AVOCADO_PESTS_TO_REMOVE,
            "schema_reloaded": (not skip_schema),
        },
        "log": log,
    }


if __name__ == "__main__":  # pragma: no cover
    print(json.dumps(run(dry_run=True), indent=2, default=str))
