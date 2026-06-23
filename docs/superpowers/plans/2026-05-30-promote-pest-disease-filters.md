# Promote Pest Filter & Disease Filter to Standalone DocTypes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `Pest Filter` and `Disease Filter` from child tables of `Crop Scouted` into standalone DocTypes linked back via a `crop_scouted` field, so their `Pests Stages` / `Disease Stages` child tables become Frappe-managed and stop being orphaned on every save.

**Architecture:** Keep doctype names and row names unchanged (so existing stage rows stay attached and all name-based code keeps working). Flip `istable` 1→0, add an indexed `crop_scouted` Link, migrate `parent`→`crop_scouted` in a pre-model-sync patch before the `parent` column is dropped, then swap the ~6 "child-of-crop" queries to filter by `crop_scouted`. Stages are edited inline on the now-standalone filter form, retiring the old dialog workaround.

**Tech Stack:** Frappe v15 (Python controllers, DocType JSON, patches), MariaDB, FrappeTestCase. React frontend unaffected in shape.

**Spec:** `docs/superpowers/specs/2026-05-30-promote-pest-disease-filters-design.md`

**Commit convention for this repo:** NO `Co-Authored-By` trailer (see `CLAUDE.md`).

---

## File map

- **Modify** `upande_scp/upande_scp/doctype/pest_filter/pest_filter.json` — istable→0, add `crop_scouted`, autoname, perms, links.
- **Modify** `upande_scp/upande_scp/doctype/disease_filter/disease_filter.json` — same.
- **Modify** `upande_scp/upande_scp/doctype/crop_scouted/crop_scouted.json` — drop `pests`/`diseases` table fields + section breaks; add Document Links.
- **Modify** `upande_scp/upande_scp/doctype/crop_scouted/crop_scouted.py` — `on_trash` cascade.
- **Create** `upande_scp/patches/v1_0/promote_filters_to_standalone.py` — data migration.
- **Modify** `upande_scp/patches.txt` — register new pre-sync patch; drop obsolete line.
- **Modify** `upande_scp/serverscripts/thresholds_api.py` — 3 queries.
- **Modify** `upande_scp/serverscripts/scouting_metrics.py` — 2 queries.
- **Modify** `upande_scp/serverscripts/dashboard_aggregates/_common.py` — 2 queries.
- **Modify** `upande_scp/serverscripts/mobile/get_observations_details.py` — 1 query.
- **Modify** `upande_scp/serverscripts/populate_avocado.py` — seed via standalone docs.
- **Modify** `doc references/create_avocado_crop.py` — seed via standalone docs.
- **Delete** `upande_scp/serverscripts/pest_filter_api.py` — dialog backend no longer needed.
- **Rewrite** `upande_scp/upande_scp/doctype/crop_scouted/crop_scouted.js` — drop grid hijack.
- **Delete** `upande_scp/patches/v1_0/migrate_pest_stages_to_pest_filter.py` + repair/diagnose scripts under `doc references/fixes/`.
- **Create** `upande_scp/upande_scp/doctype/pest_filter/test_pest_filter.py` — regression + migration tests.

**No change needed** (verified — these query Pest Filter globally with no crop/parent filter): `serverscripts/get_scouting_report.py`, `serverscripts/cache_utils.py::_build_pests_group`. The `_DOC_INVALIDATIONS` map and `hooks.doc_events` keep working as-is because doctype names are unchanged.

---

## Task 1: Make Pest Filter a standalone DocType

**Files:**
- Modify: `upande_scp/upande_scp/doctype/pest_filter/pest_filter.json`

- [ ] **Step 1: Replace the JSON with the standalone definition**

Replace the entire file with (changes: `istable` removed/0, `autoname: "hash"`, new `crop_scouted` Link first in `field_order`, real `permissions`, `links` to show on Crop Scouted):

```json
{
 "actions": [],
 "allow_rename": 1,
 "autoname": "hash",
 "creation": "2026-04-18 00:00:00.000000",
 "doctype": "DocType",
 "editable_grid": 1,
 "engine": "InnoDB",
 "field_order": [
  "crop_scouted",
  "pest",
  "unit",
  "low_threshold",
  "moderate_threshold",
  "high_threshold",
  "stages"
 ],
 "fields": [
  {
   "fieldname": "crop_scouted",
   "fieldtype": "Link",
   "in_list_view": 1,
   "in_standard_filter": 1,
   "label": "Crop Scouted",
   "options": "Crop Scouted",
   "reqd": 1,
   "search_index": 1
  },
  {
   "fieldname": "pest",
   "fieldtype": "Link",
   "in_list_view": 1,
   "label": "Pest",
   "options": "Pest",
   "reqd": 1
  },
  {
   "default": "Per Zone %",
   "description": "Threshold denominator. \"Per Zone %\" = percentage of the greenhouse's zones where the pest appeared. \"Per Warehouse\" / \"Per Hectare\" keep the legacy count-based semantics for back-compat.",
   "fieldname": "unit",
   "fieldtype": "Select",
   "in_list_view": 1,
   "label": "Unit",
   "options": "Per Zone %\nPer Warehouse\nPer Hectare"
  },
  {
   "description": "Pest count at which severity becomes Low (threshold value).",
   "fieldname": "low_threshold",
   "fieldtype": "Float",
   "label": "Low Threshold",
   "non_negative": 1,
   "precision": "4"
  },
  {
   "description": "Pest count at which severity becomes Moderate (threshold value).",
   "fieldname": "moderate_threshold",
   "fieldtype": "Float",
   "label": "Moderate Threshold",
   "non_negative": 1,
   "precision": "4"
  },
  {
   "description": "Pest count at which severity becomes High (threshold value).",
   "fieldname": "high_threshold",
   "fieldtype": "Float",
   "label": "High Threshold",
   "non_negative": 1,
   "precision": "4"
  },
  {
   "fieldname": "stages",
   "fieldtype": "Table",
   "label": "Stages",
   "options": "Pests Stages"
  }
 ],
 "grid_page_length": 50,
 "index_web_pages_for_search": 1,
 "links": [],
 "modified": "2026-05-30 00:00:00.000000",
 "modified_by": "Administrator",
 "module": "Upande Scp",
 "name": "Pest Filter",
 "naming_rule": "Random",
 "owner": "Administrator",
 "permissions": [
  {
   "create": 1, "delete": 1, "email": 1, "export": 1, "print": 1,
   "read": 1, "report": 1, "role": "System Manager", "share": 1, "write": 1
  },
  {
   "create": 1, "delete": 1, "export": 1, "print": 1,
   "read": 1, "report": 1, "role": "General Manager", "share": 1, "write": 1
  }
 ],
 "row_format": "Dynamic",
 "sort_field": "modified",
 "sort_order": "DESC",
 "states": [],
 "title_field": "pest"
}
```

Note: `in_list_view` was removed from the threshold floats (a standalone list with 7 list-view columns is noisy); `pest` + `crop_scouted` are enough in the list.

- [ ] **Step 2: Commit**

```bash
git add upande_scp/upande_scp/doctype/pest_filter/pest_filter.json
git commit -m "refactor(pest-filter): convert to standalone DocType with crop_scouted link"
```

---

## Task 2: Make Disease Filter a standalone DocType

**Files:**
- Modify: `upande_scp/upande_scp/doctype/disease_filter/disease_filter.json`

- [ ] **Step 1: Replace the JSON with the standalone definition**

```json
{
 "actions": [],
 "allow_rename": 1,
 "autoname": "hash",
 "creation": "2026-04-18 00:00:00.000000",
 "doctype": "DocType",
 "editable_grid": 1,
 "engine": "InnoDB",
 "field_order": [
  "crop_scouted",
  "disease",
  "unit",
  "low_threshold",
  "moderate_threshold",
  "high_threshold",
  "stages"
 ],
 "fields": [
  {
   "fieldname": "crop_scouted",
   "fieldtype": "Link",
   "in_list_view": 1,
   "in_standard_filter": 1,
   "label": "Crop Scouted",
   "options": "Crop Scouted",
   "reqd": 1,
   "search_index": 1
  },
  {
   "fieldname": "disease",
   "fieldtype": "Link",
   "in_list_view": 1,
   "label": "Disease",
   "options": "Plant Disease",
   "reqd": 1
  },
  {
   "default": "Per Zone %",
   "description": "Threshold denominator. \"Per Zone %\" = percentage of the greenhouse's zones where the disease appeared. \"Per Warehouse\" / \"Per Hectare\" keep the legacy count-based semantics for back-compat.",
   "fieldname": "unit",
   "fieldtype": "Select",
   "in_list_view": 1,
   "label": "Unit",
   "options": "Per Zone %\nPer Warehouse\nPer Hectare"
  },
  {
   "description": "Incident count at which severity becomes Low (threshold value).",
   "fieldname": "low_threshold",
   "fieldtype": "Float",
   "label": "Low Threshold",
   "non_negative": 1,
   "precision": "4"
  },
  {
   "description": "Incident count at which severity becomes Moderate (threshold value).",
   "fieldname": "moderate_threshold",
   "fieldtype": "Float",
   "label": "Moderate Threshold",
   "non_negative": 1,
   "precision": "4"
  },
  {
   "description": "Incident count at which severity becomes High (threshold value).",
   "fieldname": "high_threshold",
   "fieldtype": "Float",
   "label": "High Threshold",
   "non_negative": 1,
   "precision": "4"
  },
  {
   "description": "Per-stage threshold overrides. When a stage has thresholds set, severity for that stage uses them; otherwise it falls back to the values above.",
   "fieldname": "stages",
   "fieldtype": "Table",
   "label": "Stages",
   "options": "Disease Stages"
  }
 ],
 "grid_page_length": 50,
 "index_web_pages_for_search": 1,
 "links": [],
 "modified": "2026-05-30 00:00:00.000000",
 "modified_by": "Administrator",
 "module": "Upande Scp",
 "name": "Disease Filter",
 "naming_rule": "Random",
 "owner": "Administrator",
 "permissions": [
  {
   "create": 1, "delete": 1, "email": 1, "export": 1, "print": 1,
   "read": 1, "report": 1, "role": "System Manager", "share": 1, "write": 1
  },
  {
   "create": 1, "delete": 1, "export": 1, "print": 1,
   "read": 1, "report": 1, "role": "General Manager", "share": 1, "write": 1
  }
 ],
 "row_format": "Dynamic",
 "sort_field": "modified",
 "sort_order": "DESC",
 "states": [],
 "title_field": "disease"
}
```

- [ ] **Step 2: Commit**

```bash
git add upande_scp/upande_scp/doctype/disease_filter/disease_filter.json
git commit -m "refactor(disease-filter): convert to standalone DocType with crop_scouted link"
```

---

## Task 3: Drop the inline pests/diseases tables from Crop Scouted, add Connections

**Files:**
- Modify: `upande_scp/upande_scp/doctype/crop_scouted/crop_scouted.json`

- [ ] **Step 1: Remove `section_break_pests`, `pests`, `section_break_diseases`, `diseases` from `field_order`**

New `field_order` (keep everything else, in order):

```json
 "field_order": [
  "crop_name",
  "variety",
  "image",
  "farms",
  "plant_sections_scouted",
  "section_break_predators",
  "predators",
  "section_break_weeds",
  "weeds",
  "section_break_incidents",
  "incidents",
  "section_break_physiological_disorders",
  "physiological_disorders"
 ],
```

- [ ] **Step 2: Delete the four field objects** for `section_break_pests`, `pests`, `section_break_diseases`, `diseases` from the `fields` array (lines defining `"fieldname": "section_break_pests"` through the `"diseases"` Table object). Leave `predators`…`physiological_disorders` untouched.

- [ ] **Step 3: Add Document Links so the form shows a Connections tab** — replace `"links": [],` with:

```json
 "links": [
  {
   "group": "Scouting Config",
   "link_doctype": "Pest Filter",
   "link_fieldname": "crop_scouted"
  },
  {
   "group": "Scouting Config",
   "link_doctype": "Disease Filter",
   "link_fieldname": "crop_scouted"
  }
 ],
```

- [ ] **Step 4: Commit**

```bash
git add upande_scp/upande_scp/doctype/crop_scouted/crop_scouted.json
git commit -m "refactor(crop-scouted): drop inline pests/diseases tables, link filters via Connections"
```

---

## Task 4: Cascade-delete filters when a Crop Scouted is deleted

**Files:**
- Modify: `upande_scp/upande_scp/doctype/crop_scouted/crop_scouted.py`

- [ ] **Step 1: Replace the controller body**

```python
# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class CropScouted(Document):
	def on_trash(self):
		# Pest Filter / Disease Filter are now standalone docs linked by
		# `crop_scouted`, so Frappe no longer auto-deletes them with the parent.
		# Delete them explicitly; their Pests/Disease Stages children cascade.
		for dt in ("Pest Filter", "Disease Filter"):
			for name in frappe.get_all(
				dt, filters={"crop_scouted": self.name}, pluck="name"
			):
				frappe.delete_doc(dt, name, ignore_permissions=True, force=True)
```

- [ ] **Step 2: Commit**

```bash
git add upande_scp/upande_scp/doctype/crop_scouted/crop_scouted.py
git commit -m "feat(crop-scouted): cascade-delete linked Pest/Disease Filters on trash"
```

---

## Task 5: Migration patch — copy parent → crop_scouted before the column is dropped

**Files:**
- Create: `upande_scp/patches/v1_0/promote_filters_to_standalone.py`

- [ ] **Step 1: Write the patch**

```python
"""Promote Pest Filter and Disease Filter from child tables to standalone
DocTypes. Runs PRE model sync: while the `parent` column still exists, copy
each row's parent crop into a new `crop_scouted` column. After this patch,
model sync flips istable→0 and drops `parent`, but the crop link is preserved.

Pests Stages / Disease Stages rows are untouched: they keep
parent=<filter row name>, parenttype='Pest Filter'/'Disease Filter', and the
filter row names do not change, so they stay correctly attached.

Idempotent: skips a table whose crop_scouted column is already populated.
"""

import frappe


def execute():
    for table, doctype in (
        ("tabPest Filter", "Pest Filter"),
        ("tabDisease Filter", "Disease Filter"),
    ):
        if not frappe.db.table_exists(doctype):
            continue

        columns = {c["Field"] for c in frappe.db.sql(f"DESCRIBE `{table}`", as_dict=True)}

        # Already migrated (column exists and standalone sync already ran)?
        if "crop_scouted" in columns and "parent" not in columns:
            continue

        # Add the column while the table is still a child table.
        if "crop_scouted" not in columns:
            frappe.db.sql(
                f"ALTER TABLE `{table}` ADD COLUMN `crop_scouted` VARCHAR(140)"
            )

        # Copy the parent crop into crop_scouted for rows parented to a crop.
        if "parent" in columns:
            frappe.db.sql(
                f"""
                UPDATE `{table}`
                SET crop_scouted = parent
                WHERE parenttype = 'Crop Scouted'
                  AND (crop_scouted IS NULL OR crop_scouted = '')
                """
            )

        moved = frappe.db.sql(
            f"SELECT COUNT(*) FROM `{table}` WHERE crop_scouted IS NOT NULL AND crop_scouted != ''"
        )[0][0]
        print(f"  promote_filters_to_standalone: {doctype}: {moved} rows carry crop_scouted")

    frappe.db.commit()
```

- [ ] **Step 2: Commit**

```bash
git add upande_scp/patches/v1_0/promote_filters_to_standalone.py
git commit -m "feat(patch): backfill crop_scouted before promoting filters to standalone"
```

---

## Task 6: Register the new patch (pre-sync) and drop the obsolete one

**Files:**
- Modify: `upande_scp/patches.txt`

- [ ] **Step 1: Add the new patch under `[pre_model_sync]`** — it must run before doctype sync drops the `parent` column. The pre_model_sync block currently contains `upande_scp.patches.v1_0.export_sal_fixtures`. Add a line after it:

```
upande_scp.patches.v1_0.promote_filters_to_standalone
```

- [ ] **Step 2: Remove the obsolete migrate line** from `[post_model_sync]`:

Delete the line `upande_scp.patches.v1_0.migrate_pest_stages_to_pest_filter`.

- [ ] **Step 3: Commit**

```bash
git add upande_scp/patches.txt
git commit -m "chore(patches): run promote_filters pre-sync, retire pest-stages migration"
```

---

## Task 7: Swap thresholds_api.py queries to crop_scouted

**Files:**
- Modify: `upande_scp/serverscripts/thresholds_api.py`

- [ ] **Step 1: In `list_crops`**, replace the UNION query. Change both branches from `WHERE parenttype = 'Crop Scouted'` selecting `parent AS crop` to select `crop_scouted AS crop`:

```python
    rows = frappe.db.sql(
        """
        SELECT DISTINCT crop
        FROM (
            SELECT crop_scouted AS crop FROM `tabPest Filter` WHERE crop_scouted IS NOT NULL
            UNION
            SELECT crop_scouted AS crop FROM `tabDisease Filter` WHERE crop_scouted IS NOT NULL
        ) t
        WHERE crop != ''
        ORDER BY crop
        """,
        as_dict=True,
    )
    return [r["crop"] for r in rows if r.get("crop")]
```

- [ ] **Step 2: In `get_thresholds`**, change the Pest Filter query:

```python
    pest_filters = frappe.db.sql(
        """
        SELECT name, pest, unit,
               low_threshold, moderate_threshold, high_threshold
        FROM `tabPest Filter`
        WHERE crop_scouted = %(crop)s
        ORDER BY idx
        """,
        {"crop": crop},
        as_dict=True,
    )
```

…and the Disease Filter query:

```python
    disease_filters = frappe.db.sql(
        """
        SELECT name, disease, unit,
               low_threshold, moderate_threshold, high_threshold
        FROM `tabDisease Filter`
        WHERE crop_scouted = %(crop)s
        ORDER BY idx
        """,
        {"crop": crop},
        as_dict=True,
    )
```

(The `Pests Stages` / `Disease Stages` subqueries with `parenttype = 'Pest Filter'` etc. stay exactly as they are.)

- [ ] **Step 3: Commit**

```bash
git add upande_scp/serverscripts/thresholds_api.py
git commit -m "fix(thresholds-api): query filters by crop_scouted link"
```

---

## Task 8: Swap scouting_metrics.py queries

**Files:**
- Modify: `upande_scp/serverscripts/scouting_metrics.py:246-261`

- [ ] **Step 1: Replace the two queries in `get_severity_thresholds`:**

```python
    pests = frappe.db.sql(
        """
        SELECT crop_scouted AS crop, pest, unit, low_threshold, moderate_threshold, high_threshold
        FROM   `tabPest Filter`
        WHERE  crop_scouted IS NOT NULL AND crop_scouted != '' AND pest IS NOT NULL AND pest != ''
        """,
        as_dict=True,
    )
    diseases = frappe.db.sql(
        """
        SELECT crop_scouted AS crop, disease, unit, low_threshold, moderate_threshold, high_threshold
        FROM   `tabDisease Filter`
        WHERE  crop_scouted IS NOT NULL AND crop_scouted != '' AND disease IS NOT NULL AND disease != ''
        """,
        as_dict=True,
    )
```

- [ ] **Step 2: Commit**

```bash
git add upande_scp/serverscripts/scouting_metrics.py
git commit -m "fix(scouting-metrics): severity thresholds query filters by crop_scouted"
```

---

## Task 9: Swap dashboard_aggregates/_common.py queries

**Files:**
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_common.py:127-172`

- [ ] **Step 1: Replace the Pest Filter query** (keep the `tabPests Stages` subquery below it unchanged):

```python
    pest_rows = frappe.db.sql(
        """
        SELECT pf.name AS row_name, pf.pest, pf.low_threshold,
               pf.moderate_threshold, pf.high_threshold
        FROM `tabPest Filter` pf
        WHERE pf.crop_scouted = %(crop)s
        """,
        {"crop": crop},
        as_dict=True,
    )
```

- [ ] **Step 2: Replace the Disease Filter query** (keep the `tabDisease Stages` subquery unchanged):

```python
    dis_rows = frappe.db.sql(
        """
        SELECT df.name AS row_name, df.disease, df.low_threshold,
               df.moderate_threshold, df.high_threshold
        FROM `tabDisease Filter` df
        WHERE df.crop_scouted = %(crop)s
        """,
        {"crop": crop},
        as_dict=True,
    )
```

- [ ] **Step 3: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/_common.py
git commit -m "fix(dashboard-aggregates): threshold map queries filters by crop_scouted"
```

---

## Task 10: Swap mobile/get_observations_details.py query

**Files:**
- Modify: `upande_scp/serverscripts/mobile/get_observations_details.py:101-112`

- [ ] **Step 1: Replace the crop-scoped filter build** so a supplied `crop` filters by `crop_scouted` instead of `parent`/`parenttype`:

```python
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
```

(The `Pests Stages` query with `parenttype: "Pest Filter"` directly below stays unchanged.)

- [ ] **Step 2: Commit**

```bash
git add upande_scp/serverscripts/mobile/get_observations_details.py
git commit -m "fix(mobile-observations): filter pest stages by crop_scouted link"
```

---

## Task 11: Update seeding scripts to create standalone filter docs

**Files:**
- Modify: `upande_scp/serverscripts/populate_avocado.py:323-361`
- Modify: `doc references/create_avocado_crop.py:67-72`

- [ ] **Step 1: In `populate_avocado.py`**, the block currently appends to `doc.pests` and deletes child stages. Replace the "remove unwanted" + "add missing" blocks so it operates on standalone `Pest Filter` docs keyed by `crop_scouted`. Replace lines 323-361 (the two blocks plus the save) with:

```python
    # ── Existing Pest Filter docs for this crop (standalone) ───────────
    existing_filters = frappe.get_all(
        "Pest Filter",
        filters={"crop_scouted": crop_name},
        fields=["name", "pest"],
    )
    rows_by_pest = {r.pest: r.name for r in existing_filters}

    # ── Remove unwanted Pest Filter docs ───────────────────────────────
    if pests_to_remove:
        remove_set = set(pests_to_remove)
        to_drop = [(pest, name) for pest, name in rows_by_pest.items() if pest in remove_set]
        if to_drop:
            if dry_run:
                _log(log, f"  [dry-run] would remove pest filters: {[p for p, _ in to_drop]}")
            else:
                for pest, name in to_drop:
                    frappe.delete_doc("Pest Filter", name, ignore_permissions=True, force=True)
                    rows_by_pest.pop(pest, None)
                _log(log, f"  - removed pest filters: {[p for p, _ in to_drop]}")

    # ── Add any missing Pest Filter docs (stages set in the next block) ─
    for spec in pest_specs:
        pest_name = spec["common_name"]
        if pest_name not in rows_by_pest:
            if dry_run:
                _log(log, f"  [dry-run] would add pest filter {pest_name} with stages {[s['stage'] for s in spec['stages']]}")
            else:
                pf = frappe.get_doc({
                    "doctype": "Pest Filter",
                    "crop_scouted": crop_name,
                    "pest": pest_name,
                })
                pf.insert(ignore_permissions=True)
                rows_by_pest[pest_name] = pf.name
                _log(log, f"  + added pest filter: {pest_name}")
```

NOTE: the downstream "Reconcile stages" block (line 363+) iterates `pest_specs` and looks up the row by pest; update its row-name lookups to use `rows_by_pest[pest_name]` (a name string) instead of `doc.pests`. Read that block during implementation and adjust the variable it uses to resolve the filter row name; the stage insert (`parent=<filter name>`, `parenttype="Pest Filter"`) is otherwise unchanged.

- [ ] **Step 2: In `create_avocado_crop.py`**, replace lines 67-72 (the `doc.pests` append loop) with standalone-doc creation:

```python
_existing_pest_links = {
    r.pest for r in frappe.get_all(
        "Pest Filter", filters={"crop_scouted": _CROP_NAME}, fields=["pest"]
    )
}
_added = 0
for _p in _all_pests:
    if _p in _existing_pest_links:
        continue
    frappe.get_doc({
        "doctype": "Pest Filter", "crop_scouted": _CROP_NAME, "pest": _p,
    }).insert(ignore_permissions=True)
    _added += 1
```

Delete the now-orphaned `_crop.save(...)` that followed the loop (the Crop Scouted doc itself no longer carries pests). Keep the `_crop.insert()` that creates the crop.

- [ ] **Step 3: Commit**

```bash
git add upande_scp/serverscripts/populate_avocado.py "doc references/create_avocado_crop.py"
git commit -m "refactor(seed): create standalone Pest Filter docs instead of child rows"
```

---

## Task 12: Retire the dialog stage-editor workaround

**Files:**
- Delete: `upande_scp/serverscripts/pest_filter_api.py`
- Rewrite: `upande_scp/upande_scp/doctype/crop_scouted/crop_scouted.js`

- [ ] **Step 1: Delete the dialog backend**

```bash
git rm upande_scp/serverscripts/pest_filter_api.py
```

- [ ] **Step 2: Replace `crop_scouted.js`** with a minimal stub (the grid hijack referenced the removed `pests` field; stages are now edited inline on the Pest Filter form, reachable from the Connections tab):

```javascript
// Copyright (c) 2026, Upande and contributors
// For license information, please see license.txt

// Pest Filter and Disease Filter are standalone DocTypes linked to this crop
// via `crop_scouted`. Manage them (and edit each filter's Stages grid inline)
// from the Connections tab on a saved Crop Scouted document.
frappe.ui.form.on("Crop Scouted", {
	refresh(frm) {
		if (frm.is_new()) return;
		frm.add_custom_button(__("Pest Filters"), () => {
			frappe.set_route("List", "Pest Filter", { crop_scouted: frm.doc.name });
		});
		frm.add_custom_button(__("Disease Filters"), () => {
			frappe.set_route("List", "Disease Filter", { crop_scouted: frm.doc.name });
		});
	},
});
```

- [ ] **Step 3: Confirm nothing else calls the removed API**

Run: `grep -rn "pest_filter_api\|get_pest_filter_stages\|set_pest_filter_stages" --include="*.py" --include="*.js" --include="*.ts" --include="*.tsx" .`
Expected: no matches (besides this plan/spec docs).

- [ ] **Step 4: Commit**

```bash
git add upande_scp/upande_scp/doctype/crop_scouted/crop_scouted.js
git commit -m "refactor(crop-scouted): retire dialog stage editor; manage filters via Connections"
```

---

## Task 13: Delete the obsolete migration + repair/diagnose scripts

**Files:**
- Delete: `upande_scp/patches/v1_0/migrate_pest_stages_to_pest_filter.py`
- Delete: `doc references/fixes/repair_pest_filter_observations_console.py`
- Delete: `doc references/fixes/diagnose_pest_filter_observations_console.py`

- [ ] **Step 1: Confirm populate_avocado.py no longer imports the patch**

Run: `grep -rn "migrate_pest_stages_to_pest_filter" --include="*.py" .`
If `populate_avocado.py` still imports/calls it (it did at lines ~462/500-501), remove those references — the standalone structure means stages no longer need re-migration. Edit out the import and the `.execute()` call there.

- [ ] **Step 2: Delete the files**

```bash
git rm upande_scp/patches/v1_0/migrate_pest_stages_to_pest_filter.py
git rm "doc references/fixes/repair_pest_filter_observations_console.py"
git rm "doc references/fixes/diagnose_pest_filter_observations_console.py"
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: delete obsolete pest-stages migration and daily repair scripts"
```

---

## Task 14: Tests — regression (no orphaning) + migration backfill

**Files:**
- Create: `upande_scp/upande_scp/doctype/pest_filter/test_pest_filter.py`

- [ ] **Step 1: Write the failing/▶ regression test**

```python
# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

import frappe
from frappe.tests.utils import FrappeTestCase


class TestPestFilterStandalone(FrappeTestCase):
    def setUp(self):
        if not frappe.db.exists("Pest", "_TEST PF Pest"):
            frappe.get_doc({"doctype": "Pest", "common_name": "_TEST PF Pest"}).insert(
                ignore_permissions=True
            )
        if not frappe.db.exists("Crop Scouted", "_TEST PF Crop"):
            frappe.get_doc(
                {"doctype": "Crop Scouted", "crop_name": "_TEST PF Crop"}
            ).insert(ignore_permissions=True)

    def _make_filter_with_stages(self):
        pf = frappe.get_doc(
            {
                "doctype": "Pest Filter",
                "crop_scouted": "_TEST PF Crop",
                "pest": "_TEST PF Pest",
                "stages": [
                    {"stage": "Adult", "reading_type": "Count"},
                    {"stage": "Larvae", "reading_type": "Count"},
                ],
            }
        )
        pf.insert(ignore_permissions=True)
        return pf

    def test_stages_survive_resave(self):
        """The original bug: re-saving must not orphan the stages."""
        pf = self._make_filter_with_stages()
        name = pf.name

        # Re-save several times, the way an operator edit would.
        for _ in range(3):
            doc = frappe.get_doc("Pest Filter", name)
            doc.unit = "Per Zone %"
            doc.save(ignore_permissions=True)

        stages = frappe.get_all(
            "Pests Stages",
            filters={"parent": name, "parenttype": "Pest Filter"},
            pluck="stage",
        )
        self.assertEqual(sorted(stages), ["Adult", "Larvae"])

    def test_crop_scouted_filtering(self):
        pf = self._make_filter_with_stages()
        rows = frappe.get_all(
            "Pest Filter", filters={"crop_scouted": "_TEST PF Crop"}, pluck="name"
        )
        self.assertIn(pf.name, rows)

    def test_crop_delete_cascades(self):
        pf = self._make_filter_with_stages()
        frappe.delete_doc("Crop Scouted", "_TEST PF Crop", ignore_permissions=True, force=True)
        self.assertFalse(frappe.db.exists("Pest Filter", pf.name))
        self.assertFalse(
            frappe.db.exists(
                "Pests Stages", {"parent": pf.name, "parenttype": "Pest Filter"}
            )
        )
```

- [ ] **Step 2: Run the tests**

Run: `bench --site <your-test-site> run-tests --module upande_scp.upande_scp.doctype.pest_filter.test_pest_filter`
Expected: 3 passed. (Before Tasks 1/4 these would error — Pest Filter wouldn't accept `crop_scouted` and the cascade wouldn't exist.)

- [ ] **Step 3: Commit**

```bash
git add upande_scp/upande_scp/doctype/pest_filter/test_pest_filter.py
git commit -m "test(pest-filter): stages survive resave, crop filtering, delete cascade"
```

---

## Task 15: Migrate, regression-test the read paths, manual verify

- [ ] **Step 1: Run the migration**

Run: `bench --site <site> migrate`
Expected: `promote_filters_to_standalone` prints row counts; no errors; Pest Filter / Disease Filter now show as standalone doctypes (`istable` 0).

- [ ] **Step 2: Verify the backfill in the DB**

Run:
```bash
bench --site <site> mariadb -e "SELECT COUNT(*) total, COUNT(crop_scouted) linked FROM \`tabPest Filter\`; SELECT COUNT(*) FROM \`tabPests Stages\` WHERE parenttype='Pest Filter';"
```
Expected: `linked == total` (every filter has a crop), and the stages count matches pre-migration (no loss).

- [ ] **Step 3: Run the existing serverscript test suite** (the dashboard/threshold read paths):

Run: `bench --site <site> run-tests --module upande_scp.serverscripts.tests.test_dashboard_aggregates_pests_diseases`
Then the rest of `upande_scp.serverscripts.tests.*`.
Expected: all pass (the query swaps preserve return shapes).

- [ ] **Step 4: Manual smoke (desk + mobile)**
  - Open a Crop Scouted doc → Connections tab shows Pest Filter / Disease Filter with counts; **+ Add** pre-fills `crop_scouted`.
  - Open a Pest Filter → edit the Stages grid inline → save → reopen: stages persist.
  - Mobile scouting flow for that crop shows the pest's stages.
  - Settings → Thresholds tab loads and saves for the crop.

- [ ] **Step 5: Final commit (if any cleanup)**

```bash
git add -A
git commit -m "chore: finalize pest/disease filter standalone migration"
```

---

## Self-review notes (author)

- **Spec coverage:** data model (T1–T2), Crop Scouted form + Connections (T3), delete cascade (T4), migration ordering (T5–T6), every read/write swap from the sweep (T7–T11), UI workaround retirement (T12), obsolete-script deletion (T13), tests incl. the actual regression (T14–T15). ✅
- **Deliberately unchanged** (verified during planning): `get_scouting_report.py` and `cache_utils._build_pests_group` enumerate Pest Filter globally with no crop filter; `hooks.doc_events` and `_DOC_INVALIDATIONS` key on unchanged doctype names. Calling these out prevents a "did you miss these?" later.
- **Type/name consistency:** new field is `crop_scouted` everywhere; stages always queried by `parent`+`parenttype='Pest Filter'`/`'Disease Filter'` (unchanged); filter row names never change → no stage re-attachment.
- **Open item to resolve during T11:** the populate_avocado "Reconcile stages" block (line 363+) must switch its filter-row-name source to `rows_by_pest[pest_name]`; flagged inline.
```
