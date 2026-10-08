# Spray Compliance (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every pest-control product in a spray plan must target a pest/disease on the plan, every target must be covered, and mixes are checked for FRAC/IRAC sense and pairwise incompatibility — enforced server-side, with a per-rule, per-crop mode.

**Architecture:** A frappe-free rule core (`spray_compliance/rules.py`, `engine.py`) works on a plain-dict context; `context.py` is the only module that reads the database to build that context. `api.py` exposes it to the React creator; `drafts.py` and the two approval paths call the engine to enforce. Reference data lives in a new `Active Ingredient MoA` list and new fields on the settings Single; the roses sheet is loaded by `importer.py`.

**Tech Stack:** Frappe v16 / Python 3.14, MariaDB, React + TypeScript + Vite + vitest (frontend), openpyxl (bench env).

**Spec:** `docs/superpowers/specs/2026-10-08-spray-compliance-design.md`

## Global Constraints

- Site: **`kaitet.local` only**. Never the Kaitet MCP. Never run anything against live.
- `bench run-tests` cannot bootstrap on kaitet.local. Pure tests run with pytest; DB tests run with the direct runner:
  - Pure: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest upande_scp/serverscripts/tests/<file>.py -q`
  - DB: `cd /home/ubuntu/stive/code/frappe15/sites && ../env/bin/python -c "import frappe, unittest; frappe.init(site='kaitet.local'); frappe.connect(); frappe.set_user('Administrator'); from upande_scp.serverscripts.tests import <module> as T; r=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(T)); frappe.db.rollback(); raise SystemExit(not r.wasSuccessful())"`
- `rules.py` and `engine.py` must **not import frappe**.
- Rule modes, verbatim: `Off`, `Warn`, `Block (GM override)`, `Block`. Default `Warn`.
- Rule keys, verbatim: `target_match`, `target_coverage`, `same_moa_in_mix`, `moa_rotation`, `max_sprays`, `known_resistance`, `tank_mix_incompatible`. Settings fieldname = `rule_` + key.
- Override role: **`SCP General Manager`** (System Manager / Administrator also allowed).
- Codes are read from **Spray Product** (`tabIRAC Code Filter` / `tabFRAC Code Filter` with `parenttype='Spray Product'`, column `code`), never from Item.
- Non-target = category `Foliar`, or type in {`Adjuvant`, `pH Buffer`, `Plant Growth Regulator`}. Blank type on a Chemical = pest-control.
- Code master naming: FRAC `M1`, `P1`, `11`; IRAC `4A`, `UN`. Never zero-pad (`M01` is wrong here).
- Importer is fill-blanks-only and idempotent; it never creates Spray Products.
- Commits: no `Co-Authored-By` trailer (CLAUDE.md). Commit style: `feat(scp): …` lowercase sentence.
- UI: no coloured left-border strips on cards/rows; accent via icon/text colour or pill. Clean state uses a check-in-circle icon.

## Review Focus

- A product in the mix that has **no Spray Product record** (plain Item, or deleted) — engine must treat it as an untargeted pest-control product (a `target_match` violation in its mode), never crash with KeyError. → Task 2 test `test_unknown_product_is_untargeted`.
- **Same product twice** in one mix (operator added a duplicate row) — must not be reported as "same MoA in mix" against itself. → Task 2 test `test_same_product_twice_is_not_a_moa_clash`.
- A plan with **zero targets** reaching the engine (Preventive draft saved via API) — target_coverage yields nothing, target_match flags every pest-control product; no exception. → Task 2 test `test_no_targets`.
- **Malformed guideline parameter strings** (blank, `Tebuconazole:2`, `Powdery Mildew:` , stray whitespace/`\r\n`) — parsed rows skipped, never raise. → Task 3 tests `test_parse_*_tolerates_garbage`.
- **Bulk approval** of several WOs where one is blocked — the blocked one is skipped with a reason, the rest approve. → Task 7 test `test_bulk_skips_only_the_blocked_plan`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `upande_scp/upande_scp/doctype/active_ingredient_moa/` (new) | Ingredient → FRAC/IRAC code list |
| `upande_scp/upande_scp/doctype/tank_mix_incompatibility/` (new, child) | Agronomist's pair list, on the settings Single |
| `upande_scp/upande_scp/doctype/spray_rule_override/` (new, child) | Audited overrides, on Work Order |
| `upande_scp/upande_scp/doctype/scouting_and_crop_protection_settings/…json` (mod) | `spray_rules_section`, 7 `rule_*` Selects, `tank_mix_incompatibilities` |
| `upande_scp/upande_scp/doctype/spray_product/spray_product.json` (mod) | add `Plant Growth Regulator` to `type` |
| `upande_scp/serverscripts/common/custom_fields.py` (mod) | WO `custom_spray_rule_overrides`, `custom_compliance_status` |
| `upande_scp/serverscripts/spray_plan_creator/crop_settings.py` (mod) | 7 rule keys in `OVERRIDABLE` |
| `upande_scp/serverscripts/spray_compliance/__init__.py` (new) | package |
| `…/spray_compliance/ingredients.py` (new, pure) | parse + normalise ingredient strings |
| `…/spray_compliance/rules.py` (new, pure) | one function per rule + guideline parsers |
| `…/spray_compliance/engine.py` (new, pure) | modes, overrides, `check_mix`, `evaluate_candidates` |
| `…/spray_compliance/context.py` (new, DB) | build context from payload / WO |
| `…/spray_compliance/api.py` (new) | whitelisted endpoints + `enforce` helpers |
| `…/spray_compliance/moa_seed.py` (new) | seed `Active Ingredient MoA` + missing codes |
| `…/spray_compliance/importer.py` (new) | roses sheet dry-run / apply |
| `…/spray_plan_creator/drafts.py` (mod) | call `enforce_on_save` |
| `…/spray_plan_ops/spray_plan_approval.py`, `…/spray_plan_creator/bulk.py` (mod) | call `enforce_on_approval` |
| `…/spray_plan_creator/approval_review.py` (mod) | codes from Spray Product; add `compliance` |
| `upande_scp/serverscripts/tests/test_spray_compliance_*.py` (new) | tests |
| `frontend/src/lib/spray-compliance-api.ts` (+ `.test.ts`) (new) | types, calls, pure UI helpers |
| `frontend/src/components/spray-plan/SprayCheckCard.tsx` (new) | coverage grid + violations |
| `frontend/src/components/spray-plan/OverrideDialog.tsx` (new) | GM override reasons |
| `frontend/src/components/BomPicker.tsx` (mod) | eligibility annotations |
| `frontend/src/pages/ApplicationPlan.tsx` (mod) | wiring, order, pills, save gate |
| `frontend/src/components/spray-plan/ApprovalChemicalsTable.tsx` (mod) | read-only card + overrides |

---

### Task 1: Schema — new doctypes, settings fields, WO fields

**Files:**
- Create: `upande_scp/upande_scp/doctype/active_ingredient_moa/{__init__.py,active_ingredient_moa.json,active_ingredient_moa.py}`
- Create: `upande_scp/upande_scp/doctype/tank_mix_incompatibility/{__init__.py,tank_mix_incompatibility.json,tank_mix_incompatibility.py}`
- Create: `upande_scp/upande_scp/doctype/spray_rule_override/{__init__.py,spray_rule_override.json,spray_rule_override.py}`
- Modify: `upande_scp/upande_scp/doctype/scouting_and_crop_protection_settings/scouting_and_crop_protection_settings.json`
- Modify: `upande_scp/upande_scp/doctype/spray_product/spray_product.json` (`type` options)
- Modify: `upande_scp/serverscripts/common/custom_fields.py` (Work Order list)
- Modify: `upande_scp/serverscripts/spray_plan_creator/crop_settings.py` (`OVERRIDABLE`)
- Test: `upande_scp/serverscripts/tests/test_spray_compliance_schema.py`

**Interfaces:**
- Produces: doctypes `Active Ingredient MoA` (fields `ingredient`, `aliases`, `kind`, `frac_code`, `irac_code`, `notes`), `Tank Mix Incompatibility` (`product_a`, `product_b`, `ingredient_a`, `ingredient_b`, `reason`), `Spray Rule Override` (`rule`, `subject`, `reason`, `overridden_by`, `overridden_on`); settings fields `rule_<key>` ×7 and table `tank_mix_incompatibilities`; WO fields `custom_spray_rule_overrides` (Table → Spray Rule Override), `custom_compliance_status` (Select: `""`, `Clean`, `Warnings`, `Awaiting Override`, `Overridden`).

- [ ] **Step 1: Write the failing test**

`upande_scp/serverscripts/tests/test_spray_compliance_schema.py`:

```python
"""Schema for spray compliance exists after migrate. DB test — direct runner."""

import unittest

import frappe

RULES = ["target_match", "target_coverage", "same_moa_in_mix", "moa_rotation",
         "max_sprays", "known_resistance", "tank_mix_incompatible"]
MODES = ["Off", "Warn", "Block (GM override)", "Block"]


class TestSchema(unittest.TestCase):
	def test_active_ingredient_moa(self):
		meta = frappe.get_meta("Active Ingredient MoA")
		for f in ("ingredient", "aliases", "kind", "frac_code", "irac_code", "notes"):
			self.assertTrue(meta.get_field(f), f)
		self.assertEqual(meta.get_field("frac_code").options, "FRAC Code")
		self.assertEqual(meta.get_field("irac_code").options, "IRAC Code")

	def test_rule_modes_on_settings(self):
		meta = frappe.get_meta("Scouting and Crop Protection Settings")
		for r in RULES:
			f = meta.get_field(f"rule_{r}")
			self.assertTrue(f, r)
			self.assertEqual(f.options.split("\n"), MODES)
			self.assertEqual(f.default, "Warn")
		self.assertEqual(meta.get_field("tank_mix_incompatibilities").options,
		                 "Tank Mix Incompatibility")

	def test_rule_modes_are_crop_overridable(self):
		from upande_scp.serverscripts.spray_plan_creator.crop_settings import OVERRIDABLE
		for r in RULES:
			self.assertIn(f"rule_{r}", OVERRIDABLE)

	def test_work_order_fields(self):
		meta = frappe.get_meta("Work Order")
		self.assertEqual(meta.get_field("custom_spray_rule_overrides").options, "Spray Rule Override")
		self.assertIn("Awaiting Override", meta.get_field("custom_compliance_status").options)

	def test_spray_product_type_has_pgr(self):
		opts = frappe.get_meta("Spray Product").get_field("type").options.split("\n")
		self.assertIn("Plant Growth Regulator", opts)
```

- [ ] **Step 2: Run test to verify it fails**

Run the DB runner with `test_spray_compliance_schema`. Expected: errors — `DoesNotExistError: DocType Active Ingredient MoA not found`.

- [ ] **Step 3: Create the three doctypes**

`active_ingredient_moa/active_ingredient_moa.json`:

```json
{
 "actions": [],
 "allow_rename": 1,
 "autoname": "field:ingredient",
 "creation": "2026-10-08 09:00:00.000000",
 "doctype": "DocType",
 "engine": "InnoDB",
 "field_order": ["ingredient", "kind", "column_break_codes", "frac_code", "irac_code", "section_aliases", "aliases", "notes"],
 "fields": [
  {"fieldname": "ingredient", "fieldtype": "Data", "label": "Active Ingredient", "reqd": 1, "unique": 1, "in_list_view": 1},
  {"fieldname": "kind", "fieldtype": "Select", "label": "Kind", "options": "Fungicide\nInsecticide\nBactericide\nBiological\nPlant Growth Regulator\nAdjuvant\nOther", "in_list_view": 1, "in_standard_filter": 1},
  {"fieldname": "column_break_codes", "fieldtype": "Column Break"},
  {"fieldname": "frac_code", "fieldtype": "Link", "label": "FRAC Code", "options": "FRAC Code", "in_list_view": 1},
  {"fieldname": "irac_code", "fieldtype": "Link", "label": "IRAC Code", "options": "IRAC Code", "in_list_view": 1},
  {"fieldname": "section_aliases", "fieldtype": "Section Break"},
  {"fieldname": "aliases", "fieldtype": "Small Text", "label": "Aliases", "description": "Other spellings, one per line. Matching ignores case, punctuation and concentrations."},
  {"fieldname": "notes", "fieldtype": "Small Text", "label": "Notes"}
 ],
 "index_web_pages_for_search": 0,
 "links": [],
 "modified": "2026-10-08 09:00:00.000000",
 "modified_by": "Administrator",
 "module": "Upande Scp",
 "name": "Active Ingredient MoA",
 "naming_rule": "By fieldname",
 "owner": "Administrator",
 "permissions": [
  {"create": 1, "delete": 1, "email": 1, "export": 1, "print": 1, "read": 1, "report": 1, "role": "SCP General Manager", "share": 1, "write": 1},
  {"create": 1, "delete": 1, "email": 1, "export": 1, "print": 1, "read": 1, "report": 1, "role": "System Manager", "share": 1, "write": 1}
 ],
 "row_format": "Dynamic",
 "sort_field": "ingredient",
 "sort_order": "ASC",
 "states": [],
 "title_field": "ingredient",
 "track_changes": 1
}
```

`tank_mix_incompatibility/tank_mix_incompatibility.json`:

```json
{
 "actions": [],
 "creation": "2026-10-08 09:00:00.000000",
 "doctype": "DocType",
 "editable_grid": 1,
 "engine": "InnoDB",
 "field_order": ["product_a", "ingredient_a", "product_b", "ingredient_b", "reason"],
 "fields": [
  {"fieldname": "product_a", "fieldtype": "Link", "label": "Product A", "options": "Spray Product", "in_list_view": 1},
  {"fieldname": "ingredient_a", "fieldtype": "Link", "label": "or Ingredient A", "options": "Active Ingredient MoA", "in_list_view": 1},
  {"fieldname": "product_b", "fieldtype": "Link", "label": "Product B", "options": "Spray Product", "in_list_view": 1},
  {"fieldname": "ingredient_b", "fieldtype": "Link", "label": "or Ingredient B", "options": "Active Ingredient MoA", "in_list_view": 1},
  {"fieldname": "reason", "fieldtype": "Small Text", "label": "Reason", "reqd": 1, "in_list_view": 1}
 ],
 "istable": 1,
 "links": [],
 "modified": "2026-10-08 09:00:00.000000",
 "modified_by": "Administrator",
 "module": "Upande Scp",
 "name": "Tank Mix Incompatibility",
 "owner": "Administrator",
 "permissions": [],
 "row_format": "Dynamic",
 "sort_field": "modified",
 "sort_order": "DESC",
 "states": []
}
```

`spray_rule_override/spray_rule_override.json`:

```json
{
 "actions": [],
 "creation": "2026-10-08 09:00:00.000000",
 "doctype": "DocType",
 "editable_grid": 1,
 "engine": "InnoDB",
 "field_order": ["rule", "subject", "reason", "overridden_by", "overridden_on"],
 "fields": [
  {"fieldname": "rule", "fieldtype": "Data", "label": "Rule", "in_list_view": 1, "read_only": 1},
  {"fieldname": "subject", "fieldtype": "Data", "label": "Subject", "in_list_view": 1, "read_only": 1},
  {"fieldname": "reason", "fieldtype": "Small Text", "label": "Reason", "reqd": 1, "in_list_view": 1, "read_only": 1},
  {"fieldname": "overridden_by", "fieldtype": "Link", "label": "Overridden By", "options": "User", "in_list_view": 1, "read_only": 1},
  {"fieldname": "overridden_on", "fieldtype": "Datetime", "label": "Overridden On", "read_only": 1}
 ],
 "istable": 1,
 "links": [],
 "modified": "2026-10-08 09:00:00.000000",
 "modified_by": "Administrator",
 "module": "Upande Scp",
 "name": "Spray Rule Override",
 "owner": "Administrator",
 "permissions": [],
 "row_format": "Dynamic",
 "sort_field": "modified",
 "sort_order": "DESC",
 "states": []
}
```

Each `.py` follows `chemical_targets.py` exactly, e.g.:

```python
# Copyright (c) 2026, Upande and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class ActiveIngredientMoA(Document):
	pass
```

(`TankMixIncompatibility`, `SprayRuleOverride` likewise.) `__init__.py` files are empty.

- [ ] **Step 4: Add the settings fields**

Run this one-off edit (scratchpad script, not committed) to insert after `frac_rotation_window_days` in both `fields` and `field_order`:

```python
import json, pathlib
p = pathlib.Path("upande_scp/upande_scp/doctype/scouting_and_crop_protection_settings/scouting_and_crop_protection_settings.json")
d = json.loads(p.read_text())
MODES = "Off\nWarn\nBlock (GM override)\nBlock"
rules = [
 ("target_match", "Product targets a selected pest/disease"),
 ("target_coverage", "Every selected target is covered"),
 ("same_moa_in_mix", "No two products share a FRAC/IRAC group in one tank"),
 ("moa_rotation", "FRAC/IRAC rotation on the greenhouse (Alternate MoA guideline)"),
 ("max_sprays", "Max sprays / required break (guideline)"),
 ("known_resistance", "No product whose group a target resists (guideline)"),
 ("tank_mix_incompatible", "No pair from the incompatibility list"),
]
new = [{"fieldname": "spray_rules_section", "fieldtype": "Section Break", "label": "Spray Rules",
        "description": "How each check treats a spray plan. Warn saves and shows it; Block (GM override) needs an SCP General Manager's reason; Block cannot be saved. A crop may override these below."}]
for key, label in rules:
    new.append({"fieldname": f"rule_{key}", "fieldtype": "Select", "label": label,
                "options": MODES, "default": "Warn"})
new.append({"fieldname": "tank_mix_incompatibilities", "fieldtype": "Table",
            "label": "Tank Mix Incompatibilities", "options": "Tank Mix Incompatibility"})
anchor = d["field_order"].index("frac_rotation_window_days") + 1
d["field_order"][anchor:anchor] = [f["fieldname"] for f in new]
fi = next(i for i, f in enumerate(d["fields"]) if f["fieldname"] == "frac_rotation_window_days") + 1
d["fields"][fi:fi] = new
d["modified"] = "2026-10-08 09:00:00.000000"
p.write_text(json.dumps(d, indent=1, ensure_ascii=False) + "\n")
```

Then in `spray_product.json`, the `type` field's `options` becomes `"\nInsecticide\nFungicide\nAdjuvant\npH Buffer\nPlant Growth Regulator"` and bump `modified`.

- [ ] **Step 5: Declare the WO fields and the overridable keys**

In `custom_fields.py`, append to the `"Work Order"` list, right after the `custom_targets` dict:

```python
			{
				"fieldname": "custom_compliance_status",
				"label": "Spray Check",
				"fieldtype": "Select",
				"options": "\nClean\nWarnings\nAwaiting Override\nOverridden",
				"insert_after": "custom_targets",
				"read_only": 1,
				"in_standard_filter": 1,
			},
			{
				"fieldname": "custom_spray_rule_overrides",
				"label": "Spray Rule Overrides",
				"fieldtype": "Table",
				"options": "Spray Rule Override",
				"insert_after": "custom_compliance_status",
				"read_only": 1,
			},
```

and change the `custom_spray_team` dict's `insert_after` from `"custom_targets"` to `"custom_spray_rule_overrides"`.

In `crop_settings.py`, append to `OVERRIDABLE`:

```python
	"rule_target_match": "Product data and resistance pressure differ by crop; roses can be strict while avocado data is still being filled.",
	"rule_target_coverage": "As above.",
	"rule_same_moa_in_mix": "As above.",
	"rule_moa_rotation": "As above.",
	"rule_max_sprays": "As above.",
	"rule_known_resistance": "As above.",
	"rule_tank_mix_incompatible": "As above.",
```

- [ ] **Step 6: Migrate and run the test**

Run: `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local migrate 2>&1 | tail -5`
Then the DB runner with `test_spray_compliance_schema`. Expected: 5 tests OK. Also run `test_doctype_meta_integrity` and `test_crop_settings` (DB runner) — expected OK.

- [ ] **Step 7: Commit**

```bash
git add upande_scp/upande_scp/doctype/active_ingredient_moa upande_scp/upande_scp/doctype/tank_mix_incompatibility upande_scp/upande_scp/doctype/spray_rule_override upande_scp/upande_scp/doctype/scouting_and_crop_protection_settings/scouting_and_crop_protection_settings.json upande_scp/upande_scp/doctype/spray_product/spray_product.json upande_scp/serverscripts/common/custom_fields.py upande_scp/serverscripts/spray_plan_creator/crop_settings.py upande_scp/serverscripts/tests/test_spray_compliance_schema.py
git commit -m "feat(scp): the schema spray rules are kept in — ingredient groups, rule modes, overrides"
```

---

### Task 2: Pure rules — ingredients, targets, same MoA, incompatibility

**Files:**
- Create: `upande_scp/serverscripts/spray_compliance/__init__.py` (empty)
- Create: `upande_scp/serverscripts/spray_compliance/ingredients.py`
- Create: `upande_scp/serverscripts/spray_compliance/rules.py`
- Test: `upande_scp/serverscripts/tests/test_spray_compliance_rules.py`

**Interfaces:**
- Context dict (produced by Task 5, consumed here):

```python
ctx = {
  "crop": "Rose",
  "targets": ["Thrips", "Powdery Mildew"],
  "mix": ["1111133055", "1110001"],              # item codes, may repeat
  "products": {                                    # every item in mix + history
    "1111133055": {"name": "Delegate 250wg", "category": "Chemical", "type": "Insecticide",
                    "targets": ["Thrips", "Caterpillars"], "irac": ["5"], "frac": [],
                    "ingredients": ["Spinetoram"]},
  },
  "history": [{"wo": "MFG-WO-1", "when": "2026-10-01 07:00:00", "items": ["…"]}],  # oldest first
  "guidelines": {"alternate_moa": {"irac": 2, "frac": 2},
                 "max_sprays": [{"subject": "Tebuconazole", "sprays": 2, "break_days": 14}],
                 "known_resistance": [{"kind": "frac", "target": "Powdery Mildew", "code": "11"}]},
  "incompatibilities": [{"product_a": "X", "product_b": None, "ingredient_a": None,
                          "ingredient_b": "Copper", "reason": "…"}],
  "now": "2026-10-08 09:00:00",
}
```

- Produces (`ingredients.py`): `normalise(s: str) -> str`, `split_ingredients(s: str) -> list[str]`, `match_ingredient(raw: str, index: dict[str, str]) -> str | None`, `build_index(rows: list[dict]) -> dict[str, str]`.
- Produces (`rules.py`): `is_non_target(product: dict | None) -> bool`; `violation(rule, message, products=(), targets=(), codes=()) -> dict` with keys `rule, message, products, targets, codes, key`; rule functions `target_match(ctx)`, `target_coverage(ctx)`, `same_moa_in_mix(ctx)`, `tank_mix_incompatible(ctx)` each `-> list[dict]`; `coverage(ctx) -> list[{"target", "products"}]`; constant `EXCLUDED_CODE_PREFIXES`.

- [ ] **Step 1: Write the failing tests**

`upande_scp/serverscripts/tests/test_spray_compliance_rules.py`:

```python
"""Pure spray-compliance rules. No site needed:

    cd apps/upande_scp && ../../env/bin/python -m pytest upande_scp/serverscripts/tests/test_spray_compliance_rules.py -q
"""

import copy

from upande_scp.serverscripts.spray_compliance import ingredients as I
from upande_scp.serverscripts.spray_compliance import rules as R

P = {
	"DEL": {"name": "Delegate", "category": "Chemical", "type": "Insecticide",
	        "targets": ["Thrips", "Caterpillars"], "irac": ["5"], "frac": [], "ingredients": ["Spinetoram"]},
	"SUC": {"name": "Success", "category": "Chemical", "type": "Insecticide",
	        "targets": ["Thrips"], "irac": ["5"], "frac": [], "ingredients": ["Spinosad"]},
	"COL": {"name": "Collis", "category": "Chemical", "type": "Fungicide",
	        "targets": ["Powdery Mildew"], "irac": [], "frac": ["11", "7"], "ingredients": ["Kresoxim-methyl", "Boscalid"]},
	"AMI": {"name": "Amitiv", "category": "Chemical", "type": "Fungicide",
	        "targets": ["Powdery Mildew", "Botrytis"], "irac": [], "frac": ["11"], "ingredients": ["Azoxystrobin"]},
	"SUL": {"name": "Sulpow", "category": "Chemical", "type": "Fungicide",
	        "targets": ["Powdery Mildew"], "irac": [], "frac": ["M2"], "ingredients": ["Sulphur"]},
	"THI": {"name": "Thiovit", "category": "Chemical", "type": "Fungicide",
	        "targets": ["Powdery Mildew"], "irac": [], "frac": ["M2"], "ingredients": ["Sulphur"]},
	"ADJ": {"name": "Amisil", "category": "Chemical", "type": "Adjuvant",
	        "targets": [], "irac": [], "frac": [], "ingredients": ["Organosilicone"]},
	"FOL": {"name": "Foliar X", "category": "Foliar", "type": "Insecticide",
	        "targets": [], "irac": [], "frac": [], "ingredients": []},
	"UNT": {"name": "Untyped", "category": "Chemical", "type": "",
	        "targets": [], "irac": [], "frac": [], "ingredients": []},
	"MEL": {"name": "Melody", "category": "Chemical", "type": "Fungicide",
	        "targets": ["Downy Mildew"], "irac": [], "frac": ["M1", "40"], "ingredients": ["Copper", "Iprovalicarb"]},
}


def ctx(mix, targets=("Thrips", "Powdery Mildew"), **extra):
	c = {"crop": "Rose", "targets": list(targets), "mix": list(mix), "products": copy.deepcopy(P),
	     "history": [], "guidelines": {"alternate_moa": {}, "max_sprays": [], "known_resistance": []},
	     "incompatibilities": [], "now": "2026-10-08 09:00:00"}
	c.update(extra)
	return c


# --- ingredients -------------------------------------------------------------

def test_split_and_normalise_sheet_strings():
	assert I.split_ingredients("Kresoxim-Methyl [100 g/L]; Boscalid (formerly nicobifen) [200 g/L]") == [
		"Kresoxim-Methyl", "Boscalid"]
	assert I.split_ingredients("Copper 406 g/kg + Iprovalicarb 84 g/kg") == ["Copper", "Iprovalicarb"]
	assert I.split_ingredients("Daminozide 850g/L") == ["Daminozide"]
	assert I.split_ingredients("Thiosultap-monosodium|Monosultap [400 g/kg]; Buprofezin [100 g/kg]") == [
		"Thiosultap-monosodium", "Buprofezin"]
	assert I.split_ingredients("Acetamiprid [20%]") == ["Acetamiprid"]
	assert I.split_ingredients("Fluxametamide 10EC") == ["Fluxametamide"]
	assert I.split_ingredients("") == []
	assert I.normalise("Kresoxim-Methyl") == I.normalise("kresoxim methyl")


def test_match_ingredient_uses_aliases():
	idx = I.build_index([{"ingredient": "Bacillus thuringiensis kurstaki",
	                      "aliases": "Bacillus thuringensis\nBt kurstaki"},
	                     {"ingredient": "Emamectin benzoate", "aliases": "Emamectin"}])
	assert I.match_ingredient("Bacillus thuringensis subspecies kurstaki strain SA-12", idx) == "Bacillus thuringiensis kurstaki"
	assert I.match_ingredient("Emamectin [19.2 g/L]", idx) == "Emamectin benzoate"
	assert I.match_ingredient("Unobtainium", idx) is None


# --- classification ----------------------------------------------------------

def test_non_target_classification():
	assert R.is_non_target(P["ADJ"]) and R.is_non_target(P["FOL"])
	assert not R.is_non_target(P["UNT"])          # blank type = pest-control
	assert not R.is_non_target(None)              # unknown product = pest-control


# --- target_match / coverage -------------------------------------------------

def test_target_match_flags_only_off_target_pest_control():
	v = R.target_match(ctx(["DEL", "COL", "ADJ", "FOL", "MEL"]))
	assert [x["products"] for x in v] == [["MEL"]]
	assert "Downy Mildew" in v[0]["message"]


def test_unknown_product_is_untargeted():
	v = R.target_match(ctx(["GHOST"]))
	assert v and v[0]["products"] == ["GHOST"]


def test_untyped_product_without_targets_is_flagged():
	assert R.target_match(ctx(["UNT"]))[0]["products"] == ["UNT"]


def test_target_coverage():
	assert R.target_coverage(ctx(["DEL", "COL"])) == []
	v = R.target_coverage(ctx(["COL"]))
	assert [x["targets"] for x in v] == [["Thrips"]]
	assert R.coverage(ctx(["DEL", "COL", "AMI"])) == [
		{"target": "Thrips", "products": ["DEL"]},
		{"target": "Powdery Mildew", "products": ["COL", "AMI"]}]


def test_no_targets():
	c = ctx(["DEL", "ADJ"], targets=())
	assert R.target_coverage(c) == []
	assert [x["products"] for x in R.target_match(c)] == [["DEL"]]


# --- same_moa_in_mix ---------------------------------------------------------

def test_same_group_in_mix():
	v = R.same_moa_in_mix(ctx(["DEL", "SUC"]))
	assert len(v) == 1 and v[0]["codes"] == ["IRAC 5"] and v[0]["products"] == ["DEL", "SUC"]
	v = R.same_moa_in_mix(ctx(["COL", "AMI"]))
	assert v[0]["codes"] == ["FRAC 11"]


def test_multisite_groups_may_share():
	assert R.same_moa_in_mix(ctx(["SUL", "THI"])) == []


def test_same_product_twice_is_not_a_moa_clash():
	assert R.same_moa_in_mix(ctx(["DEL", "DEL"])) == []


# --- tank_mix_incompatible ---------------------------------------------------

def test_incompatible_by_product_and_by_ingredient():
	inc = [{"product_a": "DEL", "product_b": None, "ingredient_a": None, "ingredient_b": "Copper",
	        "reason": "Copper degrades spinetoram"}]
	v = R.tank_mix_incompatible(ctx(["DEL", "MEL"], incompatibilities=inc))
	assert v and v[0]["products"] == ["DEL", "MEL"] and "Copper degrades" in v[0]["message"]
	assert R.tank_mix_incompatible(ctx(["DEL", "COL"], incompatibilities=inc)) == []


def test_incompatible_ignores_half_empty_rows_and_self_pairs():
	inc = [{"product_a": "DEL", "product_b": None, "ingredient_a": None, "ingredient_b": None, "reason": "x"},
	       {"product_a": "DEL", "product_b": "DEL", "ingredient_a": None, "ingredient_b": None, "reason": "x"}]
	assert R.tank_mix_incompatible(ctx(["DEL", "DEL"], incompatibilities=inc)) == []


def test_violation_key_is_stable():
	a = R.violation("same_moa_in_mix", "m", products=["SUC", "DEL"], codes=["IRAC 5"])
	b = R.violation("same_moa_in_mix", "other words", products=["DEL", "SUC"], codes=["IRAC 5"])
	assert a["key"] == b["key"] == "same_moa_in_mix:DEL|SUC||IRAC 5"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest upande_scp/serverscripts/tests/test_spray_compliance_rules.py -q`
Expected: FAIL — `ModuleNotFoundError: ...spray_compliance`.

- [ ] **Step 3: Implement `ingredients.py`**

```python
"""Active-ingredient strings → canonical ingredient names. Pure, no frappe.

Registration labels write the same ingredient many ways — "Kresoxim-Methyl
[100 g/L]", "Copper 406 g/kg", "Thiosultap-monosodium|Monosultap" — so matching
is on a normalised form: lower case, letters and digits only, concentrations and
bracketed asides removed.
"""

import re

_BRACKETS = re.compile(r"\[[^\]]*\]|\([^)]*\)")
_CONC = re.compile(r"\b\d+(?:[.,]\d+)?\s*(?:%|g/l|g/kg|ml/l|g|ec|sc|sl|wg|wp|sp)\b.*$", re.I)
_SPLIT = re.compile(r";|\s\+\s|\+")


def normalise(s: str) -> str:
	return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def split_ingredients(s: str) -> list[str]:
	out = []
	for part in _SPLIT.split(s or ""):
		part = _BRACKETS.sub(" ", part)
		part = part.split("|")[0]
		part = _CONC.sub("", part)
		part = re.sub(r"\s+", " ", part).strip(" :-,")
		if part:
			out.append(part)
	return out


def build_index(rows: list[dict]) -> dict[str, str]:
	"""normalised name/alias → canonical ingredient."""
	idx = {}
	for r in rows:
		canon = r["ingredient"]
		for name in [canon, *((r.get("aliases") or "").splitlines())]:
			key = normalise(name)
			if key:
				idx[key] = canon
	return idx


def match_ingredient(raw: str, index: dict[str, str]) -> str | None:
	parts = split_ingredients(raw) or [raw]
	key = normalise(parts[0])
	if key in index:
		return index[key]
	# Longest known name that the raw string starts with ("Bacillus thuringensis
	# subspecies kurstaki strain SA-12" → "bacillus thuringensis").
	best = None
	for k, canon in index.items():
		if key.startswith(k + " ") or key == k:
			if best is None or len(k) > len(best[0]):
				best = (k, canon)
	return best[1] if best else None
```

- [ ] **Step 4: Implement the first half of `rules.py`**

```python
"""Spray-plan compliance rules. Pure: every function takes the context dict built
by `context.py` and returns a list of violations. No frappe import — the rules
are tested without a site.

A violation does not know its mode; `engine.py` attaches that.
"""

from itertools import combinations

NON_TARGET_TYPES = {"Adjuvant", "pH Buffer", "Plant Growth Regulator"}

# Groups that carry no cross-resistance meaning: FRAC multi-site (M*), biologicals
# (BM*), host-defence inducers (P*), unknown (U*/UN*), not classified (NC).
EXCLUDED_CODE_PREFIXES = ("M", "BM", "P", "U", "NC")


def is_non_target(product: dict | None) -> bool:
	if not product:
		return False
	return product.get("category") == "Foliar" or (product.get("type") or "") in NON_TARGET_TYPES


def _name(ctx, code):
	return (ctx["products"].get(code) or {}).get("name") or code


def _counts(code: str) -> bool:
	return bool(code) and not code.upper().startswith(EXCLUDED_CODE_PREFIXES)


def violation(rule, message, products=(), targets=(), codes=()) -> dict:
	products, targets, codes = sorted(set(products)), sorted(set(targets)), sorted(set(codes))
	return {
		"rule": rule, "message": message,
		"products": products, "targets": targets, "codes": codes,
		"key": f"{rule}:{'|'.join(products)}|{'|'.join(targets)}|{'|'.join(codes)}",
	}


def _unique_mix(ctx):
	seen, out = set(), []
	for item in ctx["mix"]:
		if item not in seen:
			seen.add(item)
			out.append(item)
	return out


def _pest_control(ctx):
	return [i for i in _unique_mix(ctx) if not is_non_target(ctx["products"].get(i))]


def target_match(ctx) -> list[dict]:
	wanted = set(ctx["targets"])
	out = []
	for item in _pest_control(ctx):
		registered = (ctx["products"].get(item) or {}).get("targets") or []
		if not wanted.intersection(registered):
			reg = ", ".join(registered) if registered else "no registered target"
			out.append(violation(
				"target_match",
				f"{_name(ctx, item)} is registered for {reg}, not for {', '.join(ctx['targets']) or 'any selected target'}.",
				products=[item]))
	return out


def coverage(ctx) -> list[dict]:
	mix = _pest_control(ctx)
	return [
		{"target": t, "products": [i for i in mix if t in ((ctx["products"].get(i) or {}).get("targets") or [])]}
		for t in ctx["targets"]
	]


def target_coverage(ctx) -> list[dict]:
	return [
		violation("target_coverage", f"Nothing in this mix is registered for {row['target']}.",
		          targets=[row["target"]])
		for row in coverage(ctx) if not row["products"]
	]


def _codes(product: dict | None) -> list[str]:
	p = product or {}
	return [f"IRAC {c}" for c in p.get("irac") or [] if _counts(c)] + \
	       [f"FRAC {c}" for c in p.get("frac") or [] if _counts(c)]


def same_moa_in_mix(ctx) -> list[dict]:
	by_code: dict[str, list[str]] = {}
	for item in _unique_mix(ctx):
		for code in _codes(ctx["products"].get(item)):
			by_code.setdefault(code, []).append(item)
	return [
		violation("same_moa_in_mix",
		          f"{' and '.join(_name(ctx, i) for i in items)} are both {code} — one tank, one mode of action, no added protection and faster resistance.",
		          products=items, codes=[code])
		for code, items in sorted(by_code.items()) if len(items) > 1
	]


def _side_matches(ctx, item, product, ingredient) -> bool:
	if product:
		return item == product
	if ingredient:
		return ingredient in ((ctx["products"].get(item) or {}).get("ingredients") or [])
	return False


def tank_mix_incompatible(ctx) -> list[dict]:
	out, seen = [], set()
	mix = _unique_mix(ctx)
	for row in ctx["incompatibilities"]:
		a = (row.get("product_a"), row.get("ingredient_a"))
		b = (row.get("product_b"), row.get("ingredient_b"))
		if not any(a) or not any(b):
			continue
		for x, y in combinations(mix, 2):
			hit = (_side_matches(ctx, x, *a) and _side_matches(ctx, y, *b)) or \
			      (_side_matches(ctx, y, *a) and _side_matches(ctx, x, *b))
			if hit and (x, y) not in seen:
				seen.add((x, y))
				out.append(violation("tank_mix_incompatible",
				                     f"{_name(ctx, x)} and {_name(ctx, y)} must not be mixed: {row.get('reason') or 'listed as incompatible'}.",
				                     products=[x, y]))
	return out
```

- [ ] **Step 5: Run tests**

Run the pytest command from Step 2. Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add upande_scp/serverscripts/spray_compliance upande_scp/serverscripts/tests/test_spray_compliance_rules.py
git commit -m "feat(scp): rules for what a spray plan's products must target and must not share"
```

---

### Task 3: Pure rules — history and guidelines (rotation, max sprays, known resistance)

**Files:**
- Modify: `upande_scp/serverscripts/spray_compliance/rules.py`
- Test: `upande_scp/serverscripts/tests/test_spray_compliance_history.py`

**Interfaces:**
- Consumes: `violation`, `_codes`, `_unique_mix`, `_name`, `_counts` from Task 2; `ctx["history"]`, `ctx["guidelines"]`, `ctx["now"]` (strings `YYYY-MM-DD HH:MM:SS`).
- Produces: `parse_alternate_moa(text) -> int | None`, `parse_max_sprays(text) -> list[{"subject","sprays","break_days"}]`, `parse_known_resistance(text, kind) -> list[{"kind","target","code"}]`, rule functions `moa_rotation(ctx)`, `max_sprays(ctx)`, `known_resistance(ctx)`.

Semantics:
- `moa_rotation`: for each kind (`irac`, `frac`) with limit N, the sequence is the history sprays (oldest→newest) then the current mix. For each counting code in the current mix, count how many consecutive sprays ending at the current one contain that code. More than N → violation.
- `max_sprays`: `subject` matches a product by name (normalised) or by ingredient. Count history sprays in the last `break_days` days containing it; if that count ≥ `sprays` and the current mix contains it → violation.
- `known_resistance`: for each plan target, any mix product carrying the listed code for that kind → violation.

- [ ] **Step 1: Write the failing tests**

`upande_scp/serverscripts/tests/test_spray_compliance_history.py`:

```python
"""History/guideline rules. Pure: ../../env/bin/python -m pytest <this file> -q"""

from upande_scp.serverscripts.spray_compliance import rules as R
from upande_scp.serverscripts.tests.test_spray_compliance_rules import ctx


def hist(*sprays):
	"""sprays: (when, [items]) oldest first"""
	return [{"wo": f"WO-{n}", "when": when, "items": items} for n, (when, items) in enumerate(sprays)]


def g(alt=None, max_sprays=(), known=()):
	return {"alternate_moa": alt or {}, "max_sprays": list(max_sprays), "known_resistance": list(known)}


# --- parsers -----------------------------------------------------------------

def test_parse_alternate_moa():
	assert R.parse_alternate_moa("2") == 2
	assert R.parse_alternate_moa(" 3\n") == 3


def test_parse_alternate_moa_tolerates_garbage():
	assert R.parse_alternate_moa("") is None
	assert R.parse_alternate_moa("two") is None
	assert R.parse_alternate_moa(None) is None


def test_parse_max_sprays():
	assert R.parse_max_sprays("Tebuconazole:2:14\r\nLevo 2.4SL:1:20") == [
		{"subject": "Tebuconazole", "sprays": 2, "break_days": 14},
		{"subject": "Levo 2.4SL", "sprays": 1, "break_days": 20}]


def test_parse_max_sprays_tolerates_garbage():
	assert R.parse_max_sprays("Tebuconazole:2\n:1:2\nX:a:3\n\n") == []
	assert R.parse_max_sprays(None) == []


def test_parse_known_resistance():
	assert R.parse_known_resistance("Thrips:UN\nMealybugs : 4A", "irac") == [
		{"kind": "irac", "target": "Thrips", "code": "UN"},
		{"kind": "irac", "target": "Mealybugs", "code": "4A"}]


def test_parse_known_resistance_tolerates_garbage():
	assert R.parse_known_resistance("Powdery Mildew:\n:11\nnonsense", "frac") == []


# --- moa_rotation ------------------------------------------------------------

def test_rotation_allows_up_to_n_in_a_row():
	c = ctx(["DEL"], history=hist(("2026-10-01 07:00:00", ["SUC"])), guidelines=g(alt={"irac": 2}))
	assert R.moa_rotation(c) == []


def test_rotation_blocks_the_n_plus_first():
	c = ctx(["DEL"], history=hist(("2026-09-24 07:00:00", ["DEL"]), ("2026-10-01 07:00:00", ["SUC"])),
	        guidelines=g(alt={"irac": 2}))
	v = R.moa_rotation(c)
	assert len(v) == 1 and v[0]["codes"] == ["IRAC 5"] and "3" in v[0]["message"]


def test_rotation_resets_after_a_different_group():
	c = ctx(["DEL"], history=hist(("2026-09-17 07:00:00", ["DEL"]), ("2026-09-24 07:00:00", ["COL"]),
	                              ("2026-10-01 07:00:00", ["SUC"])), guidelines=g(alt={"irac": 2}))
	assert R.moa_rotation(c) == []


def test_rotation_ignores_multisite_and_unset_limits():
	c = ctx(["SUL"], history=hist(("2026-09-24 07:00:00", ["THI"]), ("2026-10-01 07:00:00", ["SUL"])),
	        guidelines=g(alt={"frac": 1}))
	assert R.moa_rotation(c) == []
	c = ctx(["DEL"], history=hist(("2026-10-01 07:00:00", ["DEL"])), guidelines=g(alt={}))
	assert R.moa_rotation(c) == []


# --- max_sprays --------------------------------------------------------------

def test_max_sprays_by_product_name_within_window():
	rule = {"subject": "Delegate", "sprays": 1, "break_days": 14}
	c = ctx(["DEL"], history=hist(("2026-10-01 07:00:00", ["DEL"])), guidelines=g(max_sprays=[rule]))
	assert R.max_sprays(c)[0]["products"] == ["DEL"]
	c = ctx(["DEL"], history=hist(("2026-09-01 07:00:00", ["DEL"])), guidelines=g(max_sprays=[rule]))
	assert R.max_sprays(c) == []


def test_max_sprays_by_ingredient():
	rule = {"subject": "Azoxystrobin", "sprays": 1, "break_days": 30}
	c = ctx(["AMI"], history=hist(("2026-10-01 07:00:00", ["AMI"])), guidelines=g(max_sprays=[rule]))
	assert R.max_sprays(c)


# --- known_resistance --------------------------------------------------------

def test_known_resistance_only_for_selected_targets():
	known = [{"kind": "frac", "target": "Powdery Mildew", "code": "11"}]
	v = R.known_resistance(ctx(["AMI", "COL", "SUL"], guidelines=g(known=known)))
	assert sorted(x["products"][0] for x in v) == ["AMI", "COL"]
	assert R.known_resistance(ctx(["AMI"], targets=["Botrytis"], guidelines=g(known=known))) == []
```

- [ ] **Step 2: Run to verify failure**

Run: `../../env/bin/python -m pytest upande_scp/serverscripts/tests/test_spray_compliance_history.py -q`
Expected: FAIL — `AttributeError: module ... has no attribute 'parse_alternate_moa'`.

- [ ] **Step 3: Append to `rules.py`**

```python
# --- guideline parsing -------------------------------------------------------
# The FRAC/IRAC Guideline parameters are free strings today (spec D7). Every
# parser skips a line it cannot read instead of raising: a typo in a settings
# record must not stop spray plans being saved.

from datetime import datetime, timedelta

from .ingredients import normalise


def _lines(text):
	return [ln.strip() for ln in (text or "").replace("\r", "\n").split("\n") if ln.strip()]


def parse_alternate_moa(text) -> int | None:
	try:
		n = int(str(text).strip())
	except (TypeError, ValueError):
		return None
	return n if n > 0 else None


def parse_max_sprays(text) -> list[dict]:
	out = []
	for ln in _lines(text):
		parts = [p.strip() for p in ln.split(":")]
		if len(parts) != 3 or not parts[0]:
			continue
		try:
			out.append({"subject": parts[0], "sprays": int(parts[1]), "break_days": int(parts[2])})
		except ValueError:
			continue
	return out


def parse_known_resistance(text, kind) -> list[dict]:
	out = []
	for ln in _lines(text):
		target, _, code = ln.partition(":")
		target, code = target.strip(), code.strip()
		if target and code:
			out.append({"kind": kind, "target": target, "code": code})
	return out


def _dt(s):
	return datetime.strptime(str(s)[:19], "%Y-%m-%d %H:%M:%S")


# --- history rules -----------------------------------------------------------

def moa_rotation(ctx) -> list[dict]:
	out = []
	limits = ctx["guidelines"].get("alternate_moa") or {}
	sprays = [h["items"] for h in ctx["history"]] + [_unique_mix(ctx)]
	for kind in ("irac", "frac"):
		n = limits.get(kind)
		if not n:
			continue
		label = kind.upper()
		current = {}
		for item in sprays[-1]:
			for c in (ctx["products"].get(item) or {}).get(kind) or []:
				if _counts(c):
					current.setdefault(c, item)
		for code, item in sorted(current.items()):
			run = 0
			for items in reversed(sprays):
				if any(code in ((ctx["products"].get(i) or {}).get(kind) or []) for i in items):
					run += 1
				else:
					break
			if run > n:
				out.append(violation("moa_rotation",
				                     f"{label} {code} ({_name(ctx, item)}) would be the {run} spray in a row on this greenhouse; the limit is {n}. Rotate to another group.",
				                     products=[item], codes=[f"{label} {code}"]))
	return out


def _carries(ctx, item, subject) -> bool:
	p = ctx["products"].get(item) or {}
	s = normalise(subject)
	return s in (normalise(p.get("name")), normalise(item)) or s in {normalise(i) for i in p.get("ingredients") or []}


def max_sprays(ctx) -> list[dict]:
	out = []
	now = _dt(ctx["now"])
	for rule in ctx["guidelines"].get("max_sprays") or []:
		cutoff = now - timedelta(days=rule["break_days"])
		for item in _unique_mix(ctx):
			if not _carries(ctx, item, rule["subject"]):
				continue
			used = sum(1 for h in ctx["history"]
			           if _dt(h["when"]) >= cutoff and any(_carries(ctx, i, rule["subject"]) for i in h["items"]))
			if used >= rule["sprays"]:
				out.append(violation("max_sprays",
				                     f"{rule['subject']} ({_name(ctx, item)}) was already sprayed {used} time(s) in the last {rule['break_days']} days; the limit is {rule['sprays']}.",
				                     products=[item]))
	return out


def known_resistance(ctx) -> list[dict]:
	out = []
	wanted = set(ctx["targets"])
	for row in ctx["guidelines"].get("known_resistance") or []:
		if row["target"] not in wanted:
			continue
		for item in _unique_mix(ctx):
			if row["code"] in ((ctx["products"].get(item) or {}).get(row["kind"]) or []):
				out.append(violation("known_resistance",
				                     f"{row['target']} is known to resist {row['kind'].upper()} {row['code']}, which {_name(ctx, item)} is.",
				                     products=[item], targets=[row["target"]], codes=[f"{row['kind'].upper()} {row['code']}"]))
	return out
```

Move the two `import` lines to the top of `rules.py` with the existing import.

- [ ] **Step 4: Run both test files**

Run: `../../env/bin/python -m pytest upande_scp/serverscripts/tests/test_spray_compliance_rules.py upande_scp/serverscripts/tests/test_spray_compliance_history.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/spray_compliance/rules.py upande_scp/serverscripts/tests/test_spray_compliance_history.py
git commit -m "feat(scp): rotation, spray-count and known-resistance rules against the greenhouse's history"
```

---

### Task 4: Pure engine — modes, overrides, check_mix, candidate evaluation

**Files:**
- Create: `upande_scp/serverscripts/spray_compliance/engine.py`
- Test: `upande_scp/serverscripts/tests/test_spray_compliance_engine.py`

**Interfaces:**
- Consumes: all rule functions + `coverage` from Tasks 2–3; `ctx["modes"]`: `{rule_key: mode}`.
- Produces:
  - `RULES: tuple[str, ...]` (the 7 keys in the Global Constraints order), `MODES`.
  - `check_mix(ctx, overrides: list[dict] = ()) -> {"violations": [v + {"mode", "overridden"}], "blocking": bool, "needs_override": bool, "status": str, "coverage": [...]}` where `status` ∈ `Clean | Warnings | Awaiting Override | Overridden | Blocked`.
  - `evaluate_candidates(ctx, candidates: list[str]) -> list[{"item", "eligible", "worst_mode", "reasons": [str], "codes": [str], "targets": [str], "non_target": bool}]` — each candidate judged as if added to the current mix; ignores `target_coverage`.

- [ ] **Step 1: Write the failing tests**

```python
"""Engine: modes and overrides. Pure: ../../env/bin/python -m pytest <this file> -q"""

from upande_scp.serverscripts.spray_compliance import engine as E
from upande_scp.serverscripts.tests.test_spray_compliance_rules import ctx


def modes(**m):
	base = {r: "Warn" for r in E.RULES}
	base.update(m)
	return base


def test_clean_mix():
	r = E.check_mix(ctx(["DEL", "COL"], modes=modes()))
	assert r["violations"] == [] and r["status"] == "Clean" and not r["blocking"]


def test_warn_never_blocks():
	r = E.check_mix(ctx(["COL"], modes=modes()))
	assert r["status"] == "Warnings" and not r["blocking"] and r["violations"][0]["mode"] == "Warn"


def test_off_rules_are_not_evaluated():
	r = E.check_mix(ctx(["COL"], modes=modes(target_coverage="Off")))
	assert r["violations"] == []


def test_hard_block():
	r = E.check_mix(ctx(["COL"], modes=modes(target_coverage="Block")))
	assert r["blocking"] and not r["needs_override"] and r["status"] == "Blocked"


def test_gm_override_needed_then_given():
	c = ctx(["COL"], modes=modes(target_coverage="Block (GM override)"))
	r = E.check_mix(c)
	assert r["blocking"] and r["needs_override"] and r["status"] == "Awaiting Override"
	key = r["violations"][0]["key"]
	r = E.check_mix(c, overrides=[{"key": key, "reason": "Thrips spray tomorrow"}])
	assert not r["blocking"] and r["status"] == "Overridden" and r["violations"][0]["overridden"]


def test_blank_reason_is_not_an_override():
	c = ctx(["COL"], modes=modes(target_coverage="Block (GM override)"))
	key = E.check_mix(c)["violations"][0]["key"]
	assert E.check_mix(c, overrides=[{"key": key, "reason": "  "}])["blocking"]


def test_override_cannot_clear_a_hard_block():
	c = ctx(["COL"], modes=modes(target_coverage="Block"))
	key = E.check_mix(c)["violations"][0]["key"]
	assert E.check_mix(c, overrides=[{"key": key, "reason": "please"}])["blocking"]


def test_unknown_mode_is_treated_as_warn():
	r = E.check_mix(ctx(["COL"], modes=modes(target_coverage="Strict")))
	assert r["violations"][0]["mode"] == "Warn"


def test_evaluate_candidates():
	c = ctx(["DEL"], modes=modes(same_moa_in_mix="Block"))
	rows = {r["item"]: r for r in E.evaluate_candidates(c, ["COL", "SUC", "MEL", "ADJ"])}
	assert rows["COL"]["eligible"] and rows["COL"]["codes"] == ["FRAC 11", "FRAC 7"]
	assert not rows["SUC"]["eligible"] and rows["SUC"]["worst_mode"] == "Block"
	assert not rows["MEL"]["eligible"] and "Downy Mildew" in rows["MEL"]["reasons"][0]
	assert rows["ADJ"]["eligible"] and rows["ADJ"]["non_target"]
```

- [ ] **Step 2: Run to verify failure** — Expected: `ModuleNotFoundError ... engine`.

- [ ] **Step 3: Implement `engine.py`**

```python
"""Turns rule violations into a decision. Pure, no frappe.

Each rule has a mode (spec D5). `Off` rules are not run. A `Block (GM override)`
violation is cleared only by an override carrying the violation's `key` and a
non-blank reason; whether the caller may override at all is `api.py`'s concern.
"""

from . import rules as R

RULES = ("target_match", "target_coverage", "same_moa_in_mix", "moa_rotation",
         "max_sprays", "known_resistance", "tank_mix_incompatible")
OFF, WARN, GM, BLOCK = "Off", "Warn", "Block (GM override)", "Block"
MODES = (OFF, WARN, GM, BLOCK)
_SEVERITY = {OFF: 0, WARN: 1, GM: 2, BLOCK: 3}


def mode_of(ctx, rule) -> str:
	m = (ctx.get("modes") or {}).get(rule) or WARN
	return m if m in _SEVERITY else WARN


def _raw(ctx, skip=()):
	out = []
	for rule in RULES:
		if rule in skip:
			continue
		mode = mode_of(ctx, rule)
		if mode == OFF:
			continue
		for v in getattr(R, rule)(ctx):
			out.append({**v, "mode": mode})
	return out


def check_mix(ctx, overrides=()) -> dict:
	given = {o["key"] for o in overrides or () if (o.get("reason") or "").strip() and o.get("key")}
	violations = []
	for v in _raw(ctx):
		violations.append({**v, "overridden": v["mode"] == GM and v["key"] in given})
	hard = any(v["mode"] == BLOCK for v in violations)
	pending = any(v["mode"] == GM and not v["overridden"] for v in violations)
	if hard:
		status = "Blocked"
	elif pending:
		status = "Awaiting Override"
	elif any(v["overridden"] for v in violations):
		status = "Overridden"
	elif violations:
		status = "Warnings"
	else:
		status = "Clean"
	return {"violations": violations, "blocking": hard or pending, "needs_override": pending and not hard,
	        "status": status, "coverage": R.coverage(ctx)}


def evaluate_candidates(ctx, candidates) -> list[dict]:
	base = list(ctx["mix"])
	out = []
	for item in candidates:
		trial = {**ctx, "mix": base + [item]}
		mine = [v for v in _raw(trial, skip=("target_coverage",)) if item in v["products"]]
		worst = max((v["mode"] for v in mine), key=_SEVERITY.get, default=OFF)
		product = ctx["products"].get(item) or {}
		out.append({
			"item": item,
			"eligible": not mine,
			"worst_mode": worst,
			"reasons": [v["message"] for v in mine],
			"codes": R._codes(product),
			"targets": list(product.get("targets") or []),
			"non_target": R.is_non_target(product),
		})
	return out
```

Note `R._codes` already applies `_counts`; for display the UI also wants excluded codes — change `_codes` call here to a display helper: add to `rules.py`:

```python
def display_codes(product: dict | None) -> list[str]:
	p = product or {}
	return [f"IRAC {c}" for c in p.get("irac") or []] + [f"FRAC {c}" for c in p.get("frac") or []]
```

and use `R.display_codes(product)` in `evaluate_candidates`.

- [ ] **Step 4: Run the three pure test files** — Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/spray_compliance/engine.py upande_scp/serverscripts/spray_compliance/rules.py upande_scp/serverscripts/tests/test_spray_compliance_engine.py
git commit -m "feat(scp): each spray rule warns, waits for a GM, or blocks — as settings say"
```

---

### Task 5: Context loader (DB)

**Files:**
- Create: `upande_scp/serverscripts/spray_compliance/context.py`
- Test: `upande_scp/serverscripts/tests/test_spray_compliance_context.py`

**Interfaces:**
- Consumes: engine `RULES`; `crop_settings.value_for(key, crop)`; rule parsers.
- Produces:
  - `crop_for_greenhouse(greenhouse: str) -> str` — `Warehouse.custom_farm` → the first `Crop Scouted` whose `farms` child has that farm; `""` if none.
  - `load_products(items: list[str]) -> dict` — the `products` shape from Task 2 (missing Spray Product ⇒ item absent from dict).
  - `load_history(greenhouse, crop, exclude_wo=None, now=None) -> list[dict]`.
  - `build_context(*, greenhouse, targets, mix, exclude_wo=None, crop=None) -> dict` — full ctx incl. `modes`.
  - `context_for_wo(wo) -> dict` — from a Work Order doc (`custom_targets` newline string, `required_items`).
  - `pest_control_items() -> list[str]`: every non-disabled Spray Product name (for candidate lists).

- [ ] **Step 1: Write the failing test**

```python
"""Context loader against kaitet.local. DB test — direct runner. Read-only."""

import unittest

import frappe

from upande_scp.serverscripts.spray_compliance import context as C
from upande_scp.serverscripts.spray_compliance.engine import RULES


class TestContext(unittest.TestCase):
	def test_products_read_codes_from_spray_product(self):
		item = frappe.db.sql("""select parent from `tabFRAC Code Filter`
		                        where parenttype='Spray Product' limit 1""")[0][0]
		p = C.load_products([item, "NO-SUCH-ITEM"])
		self.assertIn(item, p)
		self.assertNotIn("NO-SUCH-ITEM", p)
		self.assertTrue(p[item]["frac"])
		for k in ("name", "category", "type", "targets", "irac", "frac", "ingredients"):
			self.assertIn(k, p[item])

	def test_crop_for_a_rose_greenhouse(self):
		farms = [r.farm for r in frappe.get_doc("Crop Scouted", "Rose").farms]
		gh = frappe.db.get_value("Warehouse", {"custom_farm": ["in", farms], "is_group": 0}, "name")
		self.assertEqual(C.crop_for_greenhouse(gh), "Rose")
		self.assertEqual(C.crop_for_greenhouse("Nowhere"), "")

	def test_build_context_shape(self):
		c = C.build_context(greenhouse="Nowhere", targets=["Thrips"], mix=["X"])
		self.assertEqual(set(c["modes"]), set(RULES))
		self.assertEqual(c["history"], [])
		for k in ("alternate_moa", "max_sprays", "known_resistance"):
			self.assertIn(k, c["guidelines"])
		self.assertIn("now", c)

	def test_known_resistance_from_guidelines(self):
		c = C.build_context(greenhouse="Nowhere", targets=["Powdery Mildew"], mix=[])
		self.assertIn({"kind": "frac", "target": "Powdery Mildew", "code": "11"},
		              c["guidelines"]["known_resistance"])
```

- [ ] **Step 2: Run to verify failure** (DB runner, `test_spray_compliance_context`) — Expected: `ModuleNotFoundError`.

- [ ] **Step 3: Implement `context.py`**

```python
"""The only spray-compliance module that reads the database. Builds the plain
context dict that `rules.py` / `engine.py` evaluate (shape documented there)."""

import frappe
from frappe.utils import add_days, now_datetime

from ..spray_plan_creator import crop_settings
from . import rules as R
from .engine import RULES

ACTIVE_STATES = ("Approved", "Chemical Issued", "Tank Mix Manufactured", "Spraying In Progress", "Completed")
SETTINGS = "Scouting and Crop Protection Settings"


def crop_for_greenhouse(greenhouse: str) -> str:
	farm = frappe.db.get_value("Warehouse", greenhouse, "custom_farm") if greenhouse else None
	if not farm:
		return ""
	row = frappe.db.sql("""select parent from `tabFarm Filter` where farm=%s
	                       and parenttype='Crop Scouted' and parentfield='farms' order by idx limit 1""", farm)
	return row[0][0] if row else ""


def _child(table, field, parents):
	out = {}
	if not parents:
		return out
	for r in frappe.db.sql(f"""select parent, `{field}` v from `tab{table}`
	                           where parenttype='Spray Product' and parent in %(p)s order by idx""",
	                       {"p": tuple(parents)}, as_dict=True):
		if r.v:
			out.setdefault(r.parent, []).append(r.v)
	return out


def load_products(items) -> dict:
	items = sorted({i for i in items if i})
	if not items:
		return {}
	rows = frappe.db.sql("""select name, product_name, category, ifnull(type,'') type
	                        from `tabSpray Product` where name in %(i)s""", {"i": tuple(items)}, as_dict=True)
	names = [r.name for r in rows]
	irac, frac = _child("IRAC Code Filter", "code", names), _child("FRAC Code Filter", "code", names)
	ingr = _child("Active Ingredient", "ingredient", names)
	targets = {}
	for r in frappe.db.sql("""select parent, ifnull(pest, disease) t from `tabChemical Targets`
	                          where parenttype='Spray Product' and parentfield='default_targets'
	                          and parent in %(p)s order by idx""", {"p": tuple(names or [""])}, as_dict=True):
		if r.t:
			targets.setdefault(r.parent, []).append(r.t)
	return {r.name: {"name": r.product_name or r.name, "category": r.category, "type": r.type,
	                 "targets": targets.get(r.name, []), "irac": irac.get(r.name, []),
	                 "frac": frac.get(r.name, []), "ingredients": ingr.get(r.name, [])}
	        for r in rows}


def load_history(greenhouse, crop, exclude_wo=None, now=None) -> list[dict]:
	if not greenhouse:
		return []
	now = now or now_datetime()
	days = max(int(crop_settings.value_for("irac_rotation_window_days", crop) or 0),
	           int(crop_settings.value_for("frac_rotation_window_days", crop) or 0), 1)
	# Max-sprays break periods can be longer than the rotation window.
	days = max([days] + [r["break_days"] for r in _max_sprays_rules()])
	rows = frappe.db.sql("""select wo.name wo, wo.custom_scheduled_application_time `when`, wi.item_code
	                        from `tabWork Order` wo join `tabWork Order Item` wi on wi.parent=wo.name
	                        where wo.custom_greenhouse=%(gh)s and wo.custom_type='Application Floor Plan'
	                          and wo.workflow_state in %(st)s and wo.name!=%(ex)s
	                          and wo.custom_scheduled_application_time >= %(cut)s
	                          and wo.custom_scheduled_application_time <= %(now)s
	                        order by wo.custom_scheduled_application_time, wo.name, wi.idx""",
	                     {"gh": greenhouse, "st": ACTIVE_STATES, "ex": exclude_wo or "",
	                      "cut": add_days(now, -days), "now": now}, as_dict=True)
	out, by = [], {}
	for r in rows:
		if r.wo not in by:
			by[r.wo] = {"wo": r.wo, "when": str(r.when)[:19], "items": []}
			out.append(by[r.wo])
		by[r.wo]["items"].append(r.item_code)
	return out


def _guideline(doctype, name):
	g = frappe.db.get_value(doctype, name, ["enabled", "parameters"], as_dict=True)
	return g.parameters if g and g.enabled else None


def _max_sprays_rules():
	return R.parse_max_sprays(_guideline("FRAC Guideline", "Max Number Of Sprays")) + \
	       R.parse_max_sprays(_guideline("IRAC Guideline", "Max Number Of Sprays"))


def load_guidelines() -> dict:
	return {
		"alternate_moa": {"irac": R.parse_alternate_moa(_guideline("IRAC Guideline", "Alternate MoA")),
		                  "frac": R.parse_alternate_moa(_guideline("FRAC Guideline", "Alternate MoA"))},
		"max_sprays": _max_sprays_rules(),
		"known_resistance": R.parse_known_resistance(_guideline("IRAC Guideline", "Target With Known Resistance"), "irac") +
		                    R.parse_known_resistance(_guideline("FRAC Guideline", "Target With Known Resistance"), "frac"),
	}


def load_incompatibilities() -> list[dict]:
	return frappe.get_all("Tank Mix Incompatibility", filters={"parent": SETTINGS, "parenttype": SETTINGS},
	                      fields=["product_a", "product_b", "ingredient_a", "ingredient_b", "reason"],
	                      order_by="idx")


def load_modes(crop) -> dict:
	return {r: crop_settings.value_for(f"rule_{r}", crop) or "Warn" for r in RULES}


def build_context(*, greenhouse, targets, mix, exclude_wo=None, crop=None) -> dict:
	crop = crop if crop is not None else crop_for_greenhouse(greenhouse)
	now = now_datetime()
	history = load_history(greenhouse, crop, exclude_wo, now)
	items = set(mix) | {i for h in history for i in h["items"]}
	return {
		"crop": crop, "targets": [t for t in targets or [] if t], "mix": [m for m in mix or [] if m],
		"products": load_products(items), "history": history, "guidelines": load_guidelines(),
		"incompatibilities": load_incompatibilities(), "modes": load_modes(crop),
		"now": now.strftime("%Y-%m-%d %H:%M:%S"),
	}


def context_for_wo(wo) -> dict:
	return build_context(greenhouse=wo.custom_greenhouse,
	                     targets=(wo.custom_targets or "").split("\n"),
	                     mix=[r.item_code for r in wo.required_items], exclude_wo=wo.name)


def pest_control_items() -> list[str]:
	return frappe.get_all("Spray Product", filters={"disabled": 0}, pluck="name")
```

`Crop Scouted.farms` is a `Farm Filter` table (verified on kaitet.local); confirm its link column is `farm` with `bench --site kaitet.local mariadb -e "describe \`tabFarm Filter\`"` before running.

- [ ] **Step 4: Run** the DB runner with `test_spray_compliance_context`. Expected: 4 OK.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/spray_compliance/context.py upande_scp/serverscripts/tests/test_spray_compliance_context.py
git commit -m "feat(scp): read a plan's products, history and spray rules for the checks"
```

---

### Task 6: API endpoints

**Files:**
- Create: `upande_scp/serverscripts/spray_compliance/api.py`
- Test: `upande_scp/serverscripts/tests/test_spray_compliance_api.py`

**Interfaces:**
- Consumes: `context.build_context`, `context.pest_control_items`, `engine.check_mix`, `engine.evaluate_candidates`.
- Produces (whitelisted, all take JSON strings or lists):
  - `check_spray_plan(greenhouse, targets, items, overrides=None, exclude_wo=None) -> check_mix result`
  - `eligible_products(greenhouse, targets, items=None, candidates=None) -> list` (`candidates` default = all active Spray Products)
  - `eligible_boms(greenhouse, targets, boms) -> list[{"bom", "eligible", "status", "coverage", "reasons"}]` (evaluated with `target_coverage` included; `reasons` = violation messages)
  - helpers (not whitelisted): `can_override(user=None) -> bool`, `result_for_payload(payload) -> dict`.

- [ ] **Step 1: Write the failing test**

```python
"""API endpoints on kaitet.local. DB test — direct runner. Read-only."""

import unittest

import frappe

from upande_scp.serverscripts.spray_compliance import api


def _product_for(target):
	return frappe.db.sql("""select parent from `tabChemical Targets` where parenttype='Spray Product'
	                        and (pest=%s or disease=%s) limit 1""", (target, target))[0][0]


class TestApi(unittest.TestCase):
	def test_check_spray_plan_shape(self):
		pm = _product_for("Powdery Mildew")
		r = api.check_spray_plan("Nowhere", '["Powdery Mildew", "Thrips"]', f'["{pm}"]')
		self.assertEqual(r["coverage"][0], {"target": "Powdery Mildew", "products": [pm]})
		self.assertIn("target_coverage", {v["rule"] for v in r["violations"]})

	def test_eligible_products_puts_the_match_first(self):
		pm = _product_for("Powdery Mildew")
		rows = api.eligible_products("Nowhere", ["Powdery Mildew"], [], [pm, "NO-SUCH"])
		self.assertTrue(rows[0]["eligible"] and rows[0]["item"] == pm)
		self.assertFalse(rows[1]["eligible"])

	def test_eligible_boms(self):
		bom = frappe.db.get_value("BOM", {"docstatus": 1, "is_active": 1}, "name")
		rows = api.eligible_boms("Nowhere", ["Thrips"], [bom])
		self.assertEqual(rows[0]["bom"], bom)
		for k in ("eligible", "status", "coverage", "reasons"):
			self.assertIn(k, rows[0])

	def test_can_override(self):
		self.assertTrue(api.can_override("Administrator"))
		self.assertFalse(api.can_override("Guest"))
```

- [ ] **Step 2: Run to verify failure** — `ModuleNotFoundError`.

- [ ] **Step 3: Implement `api.py`**

```python
"""Spray-compliance endpoints for the creator UI, plus helpers the save and
approval paths share. The server decides; the UI only shows the decision."""

import frappe

from . import context as C
from . import engine as E

OVERRIDE_ROLES = {"SCP General Manager", "System Manager"}


def _list(v):
	if v is None or v == "":
		return []
	return frappe.parse_json(v) if isinstance(v, str) else list(v)


def can_override(user=None) -> bool:
	user = user or frappe.session.user
	return user == "Administrator" or bool(OVERRIDE_ROLES & set(frappe.get_roles(user)))


@frappe.whitelist()
def check_spray_plan(greenhouse, targets, items, overrides=None, exclude_wo=None):
	ctx = C.build_context(greenhouse=greenhouse, targets=_list(targets), mix=_list(items), exclude_wo=exclude_wo)
	result = E.check_mix(ctx, _list(overrides))
	result["can_override"] = can_override()
	return result


@frappe.whitelist()
def eligible_products(greenhouse, targets, items=None, candidates=None):
	ctx = C.build_context(greenhouse=greenhouse, targets=_list(targets), mix=_list(items))
	cands = _list(candidates) or C.pest_control_items()
	ctx["products"].update(C.load_products([c for c in cands if c not in ctx["products"]]))
	rows = E.evaluate_candidates(ctx, cands)
	for r in rows:
		r["name"] = (ctx["products"].get(r["item"]) or {}).get("name") or r["item"]
	order = {E.OFF: 0, E.WARN: 1, E.GM: 2, E.BLOCK: 3}
	rows.sort(key=lambda r: (not r["eligible"], r["non_target"], order[r["worst_mode"]], r["name"].lower()))
	return rows


@frappe.whitelist()
def eligible_boms(greenhouse, targets, boms):
	boms = _list(boms)
	if not boms:
		return []
	items = {}
	for r in frappe.db.sql("""select parent, item_code from `tabBOM Item` where parent in %(b)s order by idx""",
	                       {"b": tuple(boms)}, as_dict=True):
		items.setdefault(r.parent, []).append(r.item_code)
	ctx = C.build_context(greenhouse=greenhouse, targets=_list(targets), mix=[])
	ctx["products"].update(C.load_products({i for v in items.values() for i in v}))
	out = []
	for bom in boms:
		res = E.check_mix({**ctx, "mix": items.get(bom, [])})
		out.append({"bom": bom, "eligible": not res["violations"], "status": res["status"],
		            "coverage": res["coverage"], "reasons": [v["message"] for v in res["violations"]],
		            "worst_mode": max((v["mode"] for v in res["violations"]),
		                              key={E.OFF: 0, E.WARN: 1, E.GM: 2, E.BLOCK: 3}.get, default=E.OFF)})
	return out


def result_for_payload(payload, exclude_wo=None) -> dict:
	ctx = C.build_context(greenhouse=payload.get("custom_greenhouse"),
	                      targets=payload.get("custom_targets") or [],
	                      mix=[c.get("item_code") for c in payload.get("chemicals") or []],
	                      exclude_wo=exclude_wo)
	return E.check_mix(ctx, payload.get("spray_rule_overrides") or [])
```

`eligible_boms` loads history once for the greenhouse and reuses it per BOM — no per-BOM queries.

- [ ] **Step 4: Run** DB runner with `test_spray_compliance_api`. Expected: 4 OK.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/spray_compliance/api.py upande_scp/serverscripts/tests/test_spray_compliance_api.py
git commit -m "feat(scp): endpoints that say which products and tank mixes suit a plan's targets"
```

---

### Task 7: Enforcement — draft save, approval, approval review

**Files:**
- Modify: `upande_scp/serverscripts/spray_compliance/api.py` (add `enforce_on_save`, `enforce_on_approval`)
- Modify: `upande_scp/serverscripts/spray_plan_creator/drafts.py` (`create_draft_spray_plan`, `update_draft_plan`)
- Modify: `upande_scp/serverscripts/spray_plan_ops/spray_plan_approval.py` (`approve_single_work_order`)
- Modify: `upande_scp/serverscripts/spray_plan_creator/bulk.py` (`approve_drafts_bulk`)
- Modify: `upande_scp/serverscripts/spray_plan_creator/approval_review.py`
- Test: `upande_scp/serverscripts/tests/test_spray_compliance_enforcement.py`

**Interfaces:**
- Consumes: `result_for_payload`, `can_override`, `C.context_for_wo`, `E.check_mix`.
- Produces:
  - `enforce_on_save(payload, wo, exclude_wo=None) -> dict` — throws `frappe.ValidationError` (title "Spray check failed") on a hard block, or; otherwise writes `wo.custom_compliance_status` and `wo.custom_spray_rule_overrides` and returns the result. Overrides in a payload from a user without `can_override()` are dropped (not stored, not honoured).
  - `enforce_on_approval(wo) -> dict | None` — returns `None` if approvable, else `{"reason": "<joined messages>"}`. Uses the WO's stored overrides (`key` = `subject` field).
  - Response of `create_draft_spray_plan` / `update_draft_plan` gains `"compliance": result`.
  - `get_approval_review` result gains `"compliance": check_mix result`, and `irac_codes`/`frac_codes` per chemical come from Spray Product.

Stored override row: `rule` = violation rule, `subject` = violation `key`, `reason`, `overridden_by` = session user, `overridden_on` = now.

- [ ] **Step 1: Write the failing tests**

```python
"""Enforcement on kaitet.local. DB test — direct runner. Everything it writes is
rolled back by the runner (frappe.db.rollback) and by tearDown."""

import unittest
from unittest import mock

import frappe

from upande_scp.serverscripts.spray_compliance import api
from upande_scp.serverscripts.spray_compliance import engine as E

S = "Scouting and Crop Protection Settings"


def _set_mode(rule, mode):
	frappe.db.set_single_value(S, f"rule_{rule}", mode)


class _Base(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		self._modes = {r: frappe.db.get_single_value(S, f"rule_{r}") for r in E.RULES}
		for r in E.RULES:
			_set_mode(r, "Off")

	def tearDown(self):
		frappe.set_user("Administrator")
		for r, m in self._modes.items():
			_set_mode(r, m or "Warn")
		frappe.db.rollback()


def _payload(items, targets=("Thrips",)):
	return {"custom_greenhouse": "Nowhere", "custom_targets": list(targets),
	        "chemicals": [{"item_code": i} for i in items]}


class _WO:
	"""Minimal stand-in for the WO fields enforce_on_save writes."""
	def __init__(self):
		self.custom_compliance_status = None
		self.rows = []

	def set(self, field, rows):
		self.rows = rows


class TestSave(_Base):
	def test_warn_saves_and_marks_warnings(self):
		_set_mode("target_coverage", "Warn")
		wo = _WO()
		r = api.enforce_on_save(_payload([]), wo)
		self.assertEqual(wo.custom_compliance_status, "Warnings")
		self.assertFalse(r["blocking"])

	def test_hard_block_throws(self):
		_set_mode("target_coverage", "Block")
		with self.assertRaises(frappe.ValidationError):
			api.enforce_on_save(_payload([]), _WO())

	def test_gm_override_is_stored(self):
		_set_mode("target_coverage", "Block (GM override)")
		key = api.result_for_payload(_payload([]))["violations"][0]["key"]
		p = _payload([]) | {"spray_rule_overrides": [{"key": key, "rule": "target_coverage", "reason": "Outbreak"}]}
		wo = _WO()
		api.enforce_on_save(p, wo)
		self.assertEqual(wo.custom_compliance_status, "Overridden")
		self.assertEqual(wo.rows[0]["subject"], key)
		self.assertEqual(wo.rows[0]["overridden_by"], "Administrator")

	def test_non_gm_override_is_ignored_and_draft_awaits(self):
		_set_mode("target_coverage", "Block (GM override)")
		key = api.result_for_payload(_payload([]))["violations"][0]["key"]
		p = _payload([]) | {"spray_rule_overrides": [{"key": key, "rule": "target_coverage", "reason": "x"}]}
		wo = _WO()
		with mock.patch.object(api, "can_override", return_value=False):
			api.enforce_on_save(p, wo)
		self.assertEqual(wo.custom_compliance_status, "Awaiting Override")
		self.assertEqual(wo.rows, [])


class TestApproval(_Base):
	def _wo(self, targets="Thrips", items=()):
		wo = frappe.new_doc("Work Order")
		wo.custom_greenhouse = "Nowhere"
		wo.custom_targets = targets
		wo.name = "TEST-WO-NOT-SAVED"
		for i in items:
			wo.append("required_items", {"item_code": i})
		return wo

	def test_blocked_plan_is_refused(self):
		_set_mode("target_coverage", "Block")
		self.assertIn("Thrips", api.enforce_on_approval(self._wo())["reason"])

	def test_awaiting_override_is_refused_until_overridden(self):
		_set_mode("target_coverage", "Block (GM override)")
		wo = self._wo()
		self.assertIsNotNone(api.enforce_on_approval(wo))
		key = E.check_mix(__import__("upande_scp.serverscripts.spray_compliance.context",
		                             fromlist=["x"]).context_for_wo(wo))["violations"][0]["key"]
		wo.append("custom_spray_rule_overrides", {"rule": "target_coverage", "subject": key, "reason": "ok"})
		self.assertIsNone(api.enforce_on_approval(wo))

	def test_warn_only_is_approvable(self):
		_set_mode("target_coverage", "Warn")
		self.assertIsNone(api.enforce_on_approval(self._wo()))
```

Plus, for the bulk path (Review Focus), add to the same file:

```python
class TestBulk(_Base):
	def test_bulk_skips_only_the_blocked_plan(self):
		from upande_scp.serverscripts.spray_plan_creator import bulk
		_set_mode("target_coverage", "Block")
		calls = []
		with mock.patch.object(bulk, "create_transfer_stock_entry", side_effect=lambda n: calls.append(n)), \
		     mock.patch.object(bulk, "_compliance_block", side_effect=lambda n: {"reason": "blocked"} if n == "B" else None), \
		     mock.patch.object(bulk.frappe.db, "sql", return_value=[frappe._dict(name="X", docstatus=1, workflow_state="Awaiting Approval")]), \
		     mock.patch.object(bulk.frappe.db, "set_value"), mock.patch.object(bulk.frappe.db, "commit"):
			r = bulk.approve_drafts_bulk(["A", "B", "C"])
		self.assertEqual([s["name"] for s in r["skipped"] if "blocked" in s["reason"]], ["B"])
		self.assertEqual(calls, ["A", "C"])
```

(Adjust the patched names to whatever `approve_drafts_bulk` actually calls after the transfer is created — read the rest of the function body first; the test must patch every DB write it performs.)

- [ ] **Step 2: Run to verify failure** — `AttributeError: module ... has no attribute 'enforce_on_save'`.

- [ ] **Step 3: Implement the helpers in `api.py`**

```python
def _message(result) -> str:
	return "\n".join(f"• {v['message']}" for v in result["violations"]
	                 if v["mode"] in (E.BLOCK, E.GM) and not v["overridden"])


def enforce_on_save(payload, wo, exclude_wo=None) -> dict:
	overrides = payload.get("spray_rule_overrides") or []
	if overrides and not can_override():
		overrides = []
	result = result_for_payload({**payload, "spray_rule_overrides": overrides}, exclude_wo)
	if any(v["mode"] == E.BLOCK for v in result["violations"]):
		frappe.throw(_message(result), title="Spray check failed")
	wo.custom_compliance_status = result["status"]
	by_key = {o["key"]: o for o in overrides}
	now = frappe.utils.now_datetime()
	wo.set("custom_spray_rule_overrides", [
		{"rule": v["rule"], "subject": v["key"], "reason": by_key[v["key"]]["reason"].strip(),
		 "overridden_by": frappe.session.user, "overridden_on": now}
		for v in result["violations"] if v["overridden"]
	])
	result["can_override"] = can_override()
	return result


def enforce_on_approval(wo) -> dict | None:
	overrides = [{"key": r.subject, "reason": r.reason} for r in wo.get("custom_spray_rule_overrides") or []]
	result = E.check_mix(C.context_for_wo(wo), overrides)
	if result["blocking"]:
		return {"reason": _message(result)}
	return None
```

- [ ] **Step 4: Wire draft save**

In `drafts.py`, add the import `from ..spray_compliance import api as compliance`. In `create_draft_spray_plan`, after `_apply_payload(wo, payload)` and **before** `wo.insert(...)`, add:

```python
    compliance_result = compliance.enforce_on_save(payload, wo)
```

and add `"compliance": compliance_result` to the dict it returns. In `update_draft_plan`, do the same after its `_apply_payload(wo, payload)` call, passing `exclude_wo=wo.name`. (Read both functions first; place the call where `wo` has its final `required_items` and before the save.)

- [ ] **Step 5: Wire approvals**

In `spray_plan_approval.approve_single_work_order`, right after the `workflow_state != "Awaiting Approval"` early return, add:

```python
    from upande_scp.serverscripts.spray_compliance.api import enforce_on_approval
    blocked = enforce_on_approval(wo_doc)
    if blocked:
        return {"wo": wo_name, "status": "blocked", "message": blocked["reason"]}
```

In `bulk.py`, add module-level:

```python
def _compliance_block(name):
    from upande_scp.serverscripts.spray_compliance.api import enforce_on_approval
    return enforce_on_approval(frappe.get_doc("Work Order", name))
```

and in the loop, after the `workflow_state != "Awaiting Approval"` skip and before `create_transfer_stock_entry(name)`:

```python
            blocked = _compliance_block(name)
            if blocked:
                skipped.append({"name": name, "reason": f"blocked by spray check: {blocked['reason']}"}); continue
```

- [ ] **Step 6: Fix approval review codes and add compliance**

In `approval_review.py`, change both `_get_item_codes(...)` calls to read Spray Product:

```python
        irac_codes = _get_item_codes(r.item_code, _IRAC_CHILD_TABLE, "irac", "code")
        frac_codes = _get_item_codes(r.item_code, _FRAC_CHILD_TABLE, "frac", "code")
```

and in `_get_item_codes` change `parenttype='Item'` to `parenttype='Spray Product'`. In `_detect_resistance_warnings`, change the join `cf.parenttype = 'Item'` to `'Spray Product'` and the `parent_field` values from `custom_irac`/`custom_frac` to `irac`/`frac`. Then add to the returned dict:

```python
        "compliance": _compliance(wo),
```

with

```python
def _compliance(wo) -> dict:
    from upande_scp.serverscripts.spray_compliance import context as C, engine as E
    overrides = [{"key": r.subject, "reason": r.reason} for r in wo.get("custom_spray_rule_overrides") or []]
    result = E.check_mix(C.context_for_wo(wo), overrides)
    result["overrides"] = [
        {"rule": r.rule, "reason": r.reason, "overridden_by": r.overridden_by, "overridden_on": str(r.overridden_on)}
        for r in wo.get("custom_spray_rule_overrides") or []
    ]
    return result
```

- [ ] **Step 7: Run tests** — DB runner with `test_spray_compliance_enforcement`, then `test_bulk_approve_creates_transfer` and `test_approval_date_basis` (existing; must still pass). Expected: all OK. If an existing test fails because rules default to `Warn` and fire, that is fine only if it asserts on response shape — fix the assertion to ignore `compliance`; never weaken the rule.

- [ ] **Step 8: Commit**

```bash
git add upande_scp/serverscripts/spray_compliance/api.py upande_scp/serverscripts/spray_plan_creator/drafts.py upande_scp/serverscripts/spray_plan_ops/spray_plan_approval.py upande_scp/serverscripts/spray_plan_creator/bulk.py upande_scp/serverscripts/spray_plan_creator/approval_review.py upande_scp/serverscripts/tests/test_spray_compliance_enforcement.py
git commit -m "feat(scp): spray plans are checked when saved and again when approved"
```

---

### Task 8: Active Ingredient MoA seed

**Files:**
- Create: `upande_scp/serverscripts/spray_compliance/moa_seed.py`
- Test: `upande_scp/serverscripts/tests/test_spray_compliance_seed.py`

**Interfaces:**
- Produces: `SEED: list[dict]` (`ingredient, kind, frac_code, irac_code, aliases`), `seed(dry_run=True) -> {"created": [...], "codes_created": [...], "unchanged": [...]}` — fill-blanks-only, creates missing `FRAC Code` / `IRAC Code` records it references.

- [ ] **Step 1: Write the failing test**

```python
"""MoA seed. DB test — direct runner; rolled back."""

import unittest

import frappe

from upande_scp.serverscripts.spray_compliance import moa_seed as M


class TestSeed(unittest.TestCase):
	def tearDown(self):
		frappe.db.rollback()

	def test_seed_codes_use_master_naming(self):
		for row in M.SEED:
			for c in (row.get("frac_code"), row.get("irac_code")):
				if c:
					self.assertFalse(c.startswith("M0") or c.startswith("P0"), c)

	def test_seed_is_idempotent(self):
		M.seed(dry_run=False)
		second = M.seed(dry_run=False)
		self.assertEqual(second["created"], [])
		self.assertEqual(frappe.db.get_value("Active Ingredient MoA", "Azoxystrobin", "frac_code"), "11")
		self.assertEqual(frappe.db.get_value("Active Ingredient MoA", "Spinetoram", "irac_code"), "5")

	def test_dry_run_writes_nothing(self):
		before = frappe.db.count("Active Ingredient MoA")
		M.seed(dry_run=True)
		self.assertEqual(frappe.db.count("Active Ingredient MoA"), before)
```

- [ ] **Step 2: Run to verify failure** — `ModuleNotFoundError`.

- [ ] **Step 3: Implement `moa_seed.py`**

```python
"""Seed `Active Ingredient MoA` for the ingredients on the Karen Roses approved
list. Sources: FRAC Code List 2024, IRAC MoA Classification v11. Code names follow
this site's masters (`M1`, not `M01`). Fill-blanks-only; run:

    bench --site kaitet.local execute upande_scp.serverscripts.spray_compliance.moa_seed.seed --kwargs '{"dry_run": false}'
"""

import frappe

F, I = "Fungicide", "Insecticide"
SEED = [
	# --- fungicides / bactericides (FRAC) ---
	{"ingredient": "Azoxystrobin", "kind": F, "frac_code": "11"},
	{"ingredient": "Kresoxim-methyl", "kind": F, "frac_code": "11"},
	{"ingredient": "Fluoxastrobin", "kind": F, "frac_code": "11"},
	{"ingredient": "Boscalid", "kind": F, "frac_code": "7", "aliases": "Nicobifen"},
	{"ingredient": "Fluxapyroxad", "kind": F, "frac_code": "7"},
	{"ingredient": "Difenoconazole", "kind": F, "frac_code": "3"},
	{"ingredient": "Spiroxamine", "kind": F, "frac_code": "5"},
	{"ingredient": "Dodemorph acetate", "kind": F, "frac_code": "5", "aliases": "Dodemorph"},
	{"ingredient": "Propamocarb hydrochloride", "kind": F, "frac_code": "28", "aliases": "Propamocarb"},
	{"ingredient": "Fluopicolide", "kind": F, "frac_code": "43"},
	{"ingredient": "Iprovalicarb", "kind": F, "frac_code": "40"},
	{"ingredient": "Dimethomorph", "kind": F, "frac_code": "40"},
	{"ingredient": "Mandipropamid", "kind": F, "frac_code": "40"},
	{"ingredient": "Copper", "kind": F, "frac_code": "M1", "aliases": "Copper hydroxide\nCopper oxychloride"},
	{"ingredient": "Sulphur", "kind": F, "frac_code": "M2", "aliases": "Sulfur"},
	{"ingredient": "Mancozeb", "kind": F, "frac_code": "M3"},
	{"ingredient": "Metalaxyl", "kind": F, "frac_code": "4"},
	{"ingredient": "Metalaxyl-M", "kind": F, "frac_code": "4", "aliases": "Mefenoxam"},
	{"ingredient": "Bupirimate", "kind": F, "frac_code": "8"},
	{"ingredient": "Ametoctradin", "kind": F, "frac_code": "45", "aliases": "Initium\nEnervin\nBAS 650 F"},
	{"ingredient": "Polyoxin B", "kind": F, "frac_code": "19", "aliases": "Polyoxin"},
	{"ingredient": "Fosetyl-aluminium", "kind": F, "frac_code": "P7", "aliases": "Fosetyl-Al\nFosetyl aluminium"},
	{"ingredient": "Cymoxanil", "kind": F, "frac_code": "27"},
	{"ingredient": "Tolclofos-methyl", "kind": F, "frac_code": "14"},
	{"ingredient": "Pyrimethanil", "kind": F, "frac_code": "9"},
	{"ingredient": "Cyprodinil", "kind": F, "frac_code": "9"},
	{"ingredient": "Fludioxonil", "kind": F, "frac_code": "12"},
	{"ingredient": "Fenhexamid", "kind": F, "frac_code": "17"},
	{"ingredient": "Chrysophanol", "kind": F, "frac_code": "P5"},
	# --- insecticides / acaricides (IRAC) ---
	{"ingredient": "Flubendiamide", "kind": I, "irac_code": "28"},
	{"ingredient": "Spinetoram", "kind": I, "irac_code": "5"},
	{"ingredient": "Spinosad", "kind": I, "irac_code": "5"},
	{"ingredient": "Emamectin benzoate", "kind": I, "irac_code": "6", "aliases": "Emamectin"},
	{"ingredient": "Abamectin", "kind": I, "irac_code": "6"},
	{"ingredient": "Lufenuron", "kind": I, "irac_code": "15"},
	{"ingredient": "Thiocyclam", "kind": I, "irac_code": "14", "aliases": "Thiocyclam hydrogen oxalate"},
	{"ingredient": "Thiosultap-monosodium", "kind": I, "irac_code": "14", "aliases": "Monosultap"},
	{"ingredient": "Flometoquin", "kind": I, "irac_code": "34"},
	{"ingredient": "Acetamiprid", "kind": I, "irac_code": "4A"},
	{"ingredient": "Flupyradifurone", "kind": I, "irac_code": "4D"},
	{"ingredient": "Fluxametamide", "kind": I, "irac_code": "30"},
	{"ingredient": "Spirotetramat", "kind": I, "irac_code": "23"},
	{"ingredient": "Buprofezin", "kind": I, "irac_code": "16"},
	{"ingredient": "Pyrethrins", "kind": I, "irac_code": "3A", "aliases": "Pyrethrum"},
	{"ingredient": "Methoxyfenozide", "kind": I, "irac_code": "18"},
	{"ingredient": "Chlorfenapyr", "kind": I, "irac_code": "13", "aliases": "Chlorfemepyr"},
	{"ingredient": "Flonicamid", "kind": I, "irac_code": "29", "aliases": "IKI-220"},
	{"ingredient": "Azadirachtin", "kind": I, "irac_code": "UN", "aliases": "Margosa extract\nNeem"},
	{"ingredient": "Oxymatrine", "kind": I, "irac_code": "UN", "aliases": "Matrine"},
	# --- biologicals ---
	{"ingredient": "Bacillus thuringiensis kurstaki", "kind": "Biological", "irac_code": "11A",
	 "aliases": "Bacillus thuringensis\nBacillus thuringiensis\nBt kurstaki"},
	{"ingredient": "Helicoverpa armigera nucleopolyhedrovirus", "kind": "Biological", "irac_code": "31", "aliases": "HearNPV"},
	{"ingredient": "Cryptophlebia leucotreta granulovirus", "kind": "Biological", "irac_code": "31", "aliases": "CrleGV\nCrleGV-SA"},
	{"ingredient": "Beauveria bassiana", "kind": "Biological", "irac_code": "UNF"},
	{"ingredient": "Lecanicillium muscarium", "kind": "Biological", "irac_code": "UNF", "aliases": "Verticillium lecanii\nLecanicillium"},
	# --- non-target ---
	{"ingredient": "Organosilicone", "kind": "Adjuvant"},
	{"ingredient": "Daminozide", "kind": "Plant Growth Regulator"},
]


def _ensure_code(doctype, code, created):
	if code and not frappe.db.exists(doctype, code):
		field = "frac_code" if doctype == "FRAC Code" else "moa_group"
		frappe.get_doc({"doctype": doctype, field: code}).insert(ignore_permissions=True)
		created.append(f"{doctype} {code}")


@frappe.whitelist()
def seed(dry_run=True):
	dry_run = frappe.parse_json(dry_run) if isinstance(dry_run, str) else dry_run
	report = {"created": [], "codes_created": [], "unchanged": []}
	for row in SEED:
		if frappe.db.exists("Active Ingredient MoA", row["ingredient"]):
			report["unchanged"].append(row["ingredient"])
			continue
		report["created"].append(row["ingredient"])
		if dry_run:
			continue
		_ensure_code("FRAC Code", row.get("frac_code"), report["codes_created"])
		_ensure_code("IRAC Code", row.get("irac_code"), report["codes_created"])
		frappe.get_doc({"doctype": "Active Ingredient MoA", **row}).insert(ignore_permissions=True)
	if not dry_run:
		frappe.db.commit()
	return report
```

`IRAC Code` autoname is `field:moa_group` (verified). Note the test calls `seed(dry_run=False)` which commits — move the `frappe.db.commit()` behind a `commit=True` kwarg defaulting to `not dry_run`, and have the test call `seed(dry_run=False, commit=False)` so rollback works.

- [ ] **Step 4: Run** DB runner with `test_spray_compliance_seed`. Expected: 3 OK.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/spray_compliance/moa_seed.py upande_scp/serverscripts/tests/test_spray_compliance_seed.py
git commit -m "feat(scp): the FRAC/IRAC group of every ingredient on the roses list"
```

---

### Task 9: Roses sheet importer (dry run + apply)

**Files:**
- Create: `upande_scp/serverscripts/spray_compliance/importer.py`
- Create: `upande_scp/serverscripts/tests/fixtures/roses_sheet_sample.xlsx` (built by the test's `setUpClass` if absent — no binary in the diff is fine either way; prefer building it in the test)
- Test: `upande_scp/serverscripts/tests/test_spray_compliance_importer.py`

**Interfaces:**
- Consumes: `ingredients.split_ingredients/match_ingredient/build_index/normalise`.
- Produces:
  - `TARGET_MAP: dict[str, str | None]` (normalised sheet phrase → Pest/Plant Disease name; `None` = non-target).
  - `split_targets(text) -> list[str]`, `map_target(phrase) -> (name | None, status)` with status ∈ `mapped | non_target | unmapped`.
  - `normalise_trade_name(s) -> str`.
  - `read_sheet(path) -> list[dict]` (`sno, trade_name, reg_no, ingredients_raw, targets_raw, crop`).
  - `plan(rows) -> list[dict]` per row: `matched: [item]`, `targets: [{name, kind}]`, `unmapped_targets`, `ingredients: [canon]`, `unknown_ingredients`, `irac`, `frac`, `type_fix`, `non_target`, `reg_no`.
  - `import_roses_sheet(path=None, apply=False) -> {"rows", "summary", "report_file"}`; writes HTML+CSV to `sites/kaitet.local/private/files/spray_compliance_import_<ts>.{html,csv}`.

Matching rules:
- `normalise_trade_name`: uppercase, drop text after the first digit-group that is followed by a formulation token or `%`, drop tokens in `{SC, WG, WP, EC, SL, SP, CS, EW, WSG, TM, SUPER, COMPACT, PRIME, ENERGY, GOLD, MZ, JET, DUO, N}`? — **No**: only drop formulation tokens `{SC, WG, WP, EC, SL, SP, CS, EW, WSG, TM}` and numbers/percentages; keep brand words (`PRIME`, `COMPACT`, `ENERGY`, `GOLD`). Compare on the first word when the full normalised name does not match, and report a first-word-only match as `"match": "first-word"` so duplicates surface (e.g. MELODY COMPACT vs MELODY DUO).
- A product with `kind` of all its ingredients in {Adjuvant, PGR} or a target phrase in {`adjuvant`, `plant growth regulator`} is `non_target`; set `type_fix` to `Adjuvant` / `Plant Growth Regulator` when the current type differs.
- `type_fix = "Fungicide"` when the product's derived codes are FRAC-only and its type is `Insecticide`; `"Insecticide"` when IRAC-only and typed `Fungicide`; nothing for a blank type with no codes.
- Apply = for each matched product: append missing `default_targets` rows, missing `active_ingredients` (canonical names), missing `irac`/`frac` rows, set `registration_no` if blank, set `type` if blank or `type_fix`. Never delete rows; never touch unmatched.

- [ ] **Step 1: Write the failing tests**

```python
"""Roses importer. Pure parts run anywhere; the apply test is DB (direct runner)."""

import unittest

from upande_scp.serverscripts.spray_compliance import importer as M


class TestPure(unittest.TestCase):
	def test_split_targets(self):
		self.assertEqual(M.split_targets("Thrips, Aphids and Whiteflies"), ["Thrips", "Aphids", "Whiteflies"])
		self.assertEqual(M.split_targets("Botrytis & Powdery Mildew"), ["Botrytis", "Powdery Mildew"])
		self.assertEqual(M.split_targets("Thrips, Mealybugs, Spidermites"), ["Thrips", "Mealybugs", "Spidermites"])

	def test_map_target(self):
		self.assertEqual(M.map_target("Caterpillars (Helicoverpa)"), ("Helicoverpa", "mapped"))
		self.assertEqual(M.map_target("Bollworms"), ("Helicoverpa", "mapped"))
		self.assertEqual(M.map_target("Caterpillars (Spodoptera)"), ("Spodoptera", "mapped"))
		self.assertEqual(M.map_target("Spidermites"), ("Spidermites", "mapped"))
		self.assertEqual(M.map_target("Adjuvant"), (None, "non_target"))
		self.assertEqual(M.map_target("Plant Growth Regulator"), (None, "non_target"))
		self.assertEqual(M.map_target("Soil borne fungal diseases"), (None, "unmapped"))

	def test_normalise_trade_name(self):
		self.assertEqual(M.normalise_trade_name("AMITIV 250 SC"), M.normalise_trade_name("Amitiv 250sc"))
		self.assertEqual(M.normalise_trade_name("PREVICUR ENERGY SL 840"), M.normalise_trade_name("PREVICUR ENERGY SL840"))
		self.assertNotEqual(M.normalise_trade_name("MELODY COMPACT WG 49"), M.normalise_trade_name("MELODY DUO (WG 69)"))
		self.assertEqual(M.normalise_trade_name("CRYPTOGRAN SC\xa0"), "CRYPTOGRAN")
```

and a DB class:

```python
import frappe

SHEET = "/home/ubuntu/stive/code/frappe15/apps/upande_scp/doc references/CHemicals/Crop Protection Agents + Target Pest.xlsx"


class TestDryRun(unittest.TestCase):
	def test_dry_run_reports_and_writes_nothing(self):
		before = frappe.db.count("Chemical Targets", {"parenttype": "Spray Product"})
		r = M.import_roses_sheet(SHEET, apply=False)
		self.assertEqual(frappe.db.count("Chemical Targets", {"parenttype": "Spray Product"}), before)
		self.assertEqual(len(r["rows"]), 50)
		by = {x["trade_name"]: x for x in r["rows"]}
		self.assertIn("1111101036", by["DISARM 480 SC"]["matched"])
		self.assertEqual(by["DISARM 480 SC"]["type_fix"], "Fungicide")
		self.assertEqual(by["DELEGATE 250 WG"]["irac"], ["5"])
		self.assertEqual(by["AMITIV 250 SC"]["frac"], ["11"])
		self.assertTrue(by["AMISIL"]["non_target"])
		self.assertEqual(by["RIZOLEX 50 WP"]["unmapped_targets"], ["Soil borne fungal diseases"])
		self.assertEqual(r["summary"]["unknown_ingredients"], [])

	def test_apply_is_fill_blanks_and_idempotent(self):
		M.import_roses_sheet(SHEET, apply=True, commit=False)
		n1 = frappe.db.count("Chemical Targets", {"parenttype": "Spray Product"})
		M.import_roses_sheet(SHEET, apply=True, commit=False)
		self.assertEqual(frappe.db.count("Chemical Targets", {"parenttype": "Spray Product"}), n1)
		frappe.db.rollback()
```

The DB test needs the MoA seed applied (`moa_seed.seed(dry_run=False)` in `setUpClass`, with `commit=False`).

- [ ] **Step 2: Run to verify failure** — `ModuleNotFoundError`.

- [ ] **Step 3: Implement `importer.py`**

```python
"""Load the Karen Roses approved-pesticide sheet onto Spray Products.

    # dry run — writes a report, changes nothing
    bench --site kaitet.local execute upande_scp.serverscripts.spray_compliance.importer.import_roses_sheet
    # apply after review
    bench --site kaitet.local execute upande_scp.serverscripts.spray_compliance.importer.import_roses_sheet --kwargs '{"apply": true}'

Fill-blanks-only and idempotent. Never creates or deletes a Spray Product.
"""

import csv
import html
import os
import re

import frappe
from frappe.utils import now_datetime

from .ingredients import build_index, match_ingredient, normalise, split_ingredients

DEFAULT_SHEET = os.path.join(frappe.get_app_path("upande_scp"), "..", "doc references", "CHemicals",
                             "Crop Protection Agents + Target Pest.xlsx")

TARGET_MAP = {
	"caterpillars helicoverpa": "Helicoverpa", "bollworms": "Helicoverpa", "helicoverpa": "Helicoverpa",
	"caterpillars spodoptera": "Spodoptera", "spodoptera": "Spodoptera", "caterpillars": "Caterpillars",
	"thrips": "Thrips", "aphids": "Aphids", "whiteflies": "Whiteflies", "spidermites": "Spidermites",
	"mealybugs": "Mealybugs", "fcm": "FCM",
	"botrytis": "Botrytis", "powdery mildew": "Powdery Mildew", "downy mildew": "Downy Mildew",
	"agrobacterium": "Agrobacterium",
	"adjuvant": None, "plant growth regulator": None,
}
FORMULATIONS = {"SC", "WG", "WP", "EC", "SL", "SP", "CS", "EW", "WSG", "TM"}


def split_targets(text) -> list[str]:
	parts = re.split(r",|&|\band\b", text or "")
	return [p.strip() for p in parts if p.strip()]


def map_target(phrase):
	key = normalise(phrase)
	if key not in TARGET_MAP:
		return None, "unmapped"
	name = TARGET_MAP[key]
	return (name, "mapped") if name else (None, "non_target")


def normalise_trade_name(s) -> str:
	s = re.sub(r"\([^)]*\)", " ", (s or "").replace("\xa0", " ").upper())
	s = re.sub(r"(\d)([A-Z])", r"\1 \2", s)
	s = re.sub(r"([A-Z])(\d)", r"\1 \2", s)
	words = [w for w in re.split(r"[^A-Z0-9]+", s) if w]
	words = [w for w in words if w not in FORMULATIONS and not re.fullmatch(r"\d+(\.\d+)?", w)]
	return " ".join(words)


def read_sheet(path) -> list[dict]:
	import openpyxl
	ws = openpyxl.load_workbook(path, data_only=True).worksheets[0]
	out = []
	for r in ws.iter_rows(min_row=5, values_only=True):
		if not r or not r[1]:
			continue
		out.append({"sno": str(r[0] or "").strip(), "trade_name": str(r[1]).strip(),
		            "reg_no": str(r[2] or "").strip(), "ingredients_raw": str(r[5] or "").strip(),
		            "targets_raw": str(r[6] or "").strip(), "crop": str(r[7] or "").strip()})
	return out


def _products_by_name():
	by_full, by_first = {}, {}
	for p in frappe.get_all("Spray Product", filters={"disabled": 0, "category": "Chemical"},
	                        fields=["name", "product_name", "type", "registration_no"]):
		n = normalise_trade_name(p.product_name or p.name)
		by_full.setdefault(n, []).append(p)
		if n:
			by_first.setdefault(n.split()[0], []).append(p)
	return by_full, by_first


def _moa_index():
	rows = frappe.get_all("Active Ingredient MoA", fields=["ingredient", "aliases", "kind", "frac_code", "irac_code"])
	return build_index(rows), {r.ingredient: r for r in rows}


def plan(rows) -> list[dict]:
	by_full, by_first = _products_by_name()
	index, moa = _moa_index()
	out = []
	for row in rows:
		n = normalise_trade_name(row["trade_name"])
		products = by_full.get(n) or []
		how = "full" if products else None
		if not products and n:
			products = by_first.get(n.split()[0]) or []
			how = "first-word" if products else None
		targets, unmapped, non_target = [], [], False
		for phrase in split_targets(row["targets_raw"]):
			name, status = map_target(phrase)
			if status == "mapped":
				kind = "pest" if frappe.db.exists("Pest", name) else "disease"
				targets.append({"name": name, "kind": kind})
			elif status == "non_target":
				non_target = True
			else:
				unmapped.append(phrase)
		ingredients, unknown = [], []
		for raw in split_ingredients(row["ingredients_raw"]):
			canon = match_ingredient(raw, index)
			(ingredients if canon else unknown).append(canon or raw)
		kinds = {moa[i].kind for i in ingredients}
		if kinds and kinds <= {"Adjuvant", "Plant Growth Regulator"}:
			non_target = True
		irac = sorted({moa[i].irac_code for i in ingredients if moa[i].irac_code})
		frac = sorted({moa[i].frac_code for i in ingredients if moa[i].frac_code})
		for p in products:
			fix = None
			if non_target:
				want = "Plant Growth Regulator" if "Plant Growth Regulator" in kinds or "growth" in row["targets_raw"].lower() else "Adjuvant"
				fix = want if p.type != want else None
			elif frac and not irac and p.type == "Insecticide":
				fix = "Fungicide"
			elif irac and not frac and p.type == "Fungicide":
				fix = "Insecticide"
			elif not p.type and (frac or irac):
				fix = "Fungicide" if frac and not irac else "Insecticide" if irac and not frac else None
			p["_type_fix"] = fix
		out.append({**row, "match": how, "matched": [p.name for p in products],
		            "matched_names": [p.product_name for p in products],
		            "type_fix": next((p["_type_fix"] for p in products if p["_type_fix"]), None),
		            "type_fixes": {p.name: p["_type_fix"] for p in products if p["_type_fix"]},
		            "targets": targets, "unmapped_targets": unmapped, "non_target": non_target,
		            "ingredients": ingredients, "unknown_ingredients": unknown, "irac": irac, "frac": frac})
	return out


def _apply(row):
	for item in row["matched"]:
		doc = frappe.get_doc("Spray Product", item)
		have_t = {(t.pest or t.disease) for t in doc.default_targets}
		for t in row["targets"]:
			if t["name"] not in have_t:
				doc.append("default_targets", {t["kind"]: t["name"]})
		have_i = {normalise(a.ingredient) for a in doc.active_ingredients}
		for ing in row["ingredients"]:
			if normalise(ing) not in have_i:
				doc.append("active_ingredients", {"ingredient": ing})
		for field, codes in (("irac", row["irac"]), ("frac", row["frac"])):
			have = {c.code for c in doc.get(field)}
			for c in codes:
				if c not in have:
					doc.append(field, {"code": c})
		if row["reg_no"] and not doc.registration_no:
			doc.registration_no = row["reg_no"]
		fix = row["type_fixes"].get(item)
		if fix:
			doc.type = fix
		doc.save(ignore_permissions=True)


def _write_report(rows, summary) -> str:
	ts = now_datetime().strftime("%Y%m%d-%H%M%S")
	base = frappe.get_site_path("private", "files", f"spray_compliance_import_{ts}")
	cols = ["sno", "trade_name", "match", "matched", "matched_names", "targets", "unmapped_targets",
	        "non_target", "ingredients", "unknown_ingredients", "irac", "frac", "type_fix", "reg_no"]
	with open(base + ".csv", "w", newline="") as f:
		w = csv.writer(f)
		w.writerow(cols)
		for r in rows:
			w.writerow([", ".join(t["name"] for t in r[c]) if c == "targets" else
			            ", ".join(map(str, r[c])) if isinstance(r[c], list) else r[c] for c in cols])
	cells = "".join("<tr>" + "".join(f"<td>{html.escape(str(r[c] if not isinstance(r[c], list) else ', '.join(t['name'] if isinstance(t, dict) else str(t) for t in r[c])))}</td>" for c in cols) + "</tr>" for r in rows)
	with open(base + ".html", "w") as f:
		f.write(f"<!doctype html><meta charset=utf-8><title>Spray product import</title>"
		        f"<pre>{html.escape(frappe.as_json(summary))}</pre><table border=1 cellpadding=4>"
		        f"<tr>{''.join(f'<th>{c}</th>' for c in cols)}</tr>{cells}</table>")
	return base + ".html"


@frappe.whitelist()
def import_roses_sheet(path=None, apply=False, commit=True):
	apply = frappe.parse_json(apply) if isinstance(apply, str) else apply
	rows = plan(read_sheet(path or DEFAULT_SHEET))
	summary = {
		"rows": len(rows),
		"matched": sum(1 for r in rows if r["matched"]),
		"unmatched": [r["trade_name"] for r in rows if not r["matched"]],
		"duplicates": {r["trade_name"]: r["matched_names"] for r in rows if len(r["matched"]) > 1},
		"first_word_matches": {r["trade_name"]: r["matched_names"] for r in rows if r["match"] == "first-word"},
		"unmapped_targets": sorted({t for r in rows for t in r["unmapped_targets"]}),
		"unknown_ingredients": sorted({i for r in rows for i in r["unknown_ingredients"]}),
		"type_fixes": {k: v for r in rows for k, v in r["type_fixes"].items()},
		"applied": bool(apply),
	}
	if apply:
		for r in rows:
			if r["matched"]:
				_apply(r)
		if commit:
			frappe.db.commit()
	return {"rows": rows, "summary": summary, "report_file": _write_report(rows, summary)}
```

- [ ] **Step 4: Run pure + DB tests**

Pure: `../../env/bin/python -m pytest upande_scp/serverscripts/tests/test_spray_compliance_importer.py -q -k Pure`
DB: direct runner with `test_spray_compliance_importer`.
Expected: all OK. If `unknown_ingredients` is non-empty, add the missing names as `aliases` in `moa_seed.SEED` (never weaken the assertion).

- [ ] **Step 4b: "Derive codes" button (spec §1.1)**

Add to `importer.py`:

```python
@frappe.whitelist()
def derive_codes(item):
	"""Fill a Spray Product's IRAC/FRAC rows from its active ingredients. Fill-blanks-only."""
	frappe.has_permission("Spray Product", "write", item, throw=True)
	index, moa = _moa_index()
	doc = frappe.get_doc("Spray Product", item)
	added = []
	for a in doc.active_ingredients:
		canon = match_ingredient(a.ingredient or "", index)
		if not canon:
			continue
		for field, code in (("irac", moa[canon].irac_code), ("frac", moa[canon].frac_code)):
			if code and code not in {c.code for c in doc.get(field)}:
				doc.append(field, {"code": code})
				added.append(f"{field.upper()} {code}")
	if added:
		doc.save()
	return added
```

In `upande_scp/public/js/spray_product.js`, inside the existing `refresh` handler add:

```js
frm.add_custom_button(__("Derive codes"), () =>
  frappe.call("upande_scp.serverscripts.spray_compliance.importer.derive_codes", { item: frm.doc.name })
    .then((r) => { frappe.show_alert(r.message.length ? __("Added {0}", [r.message.join(", ")]) : __("Nothing to add")); frm.reload_doc(); }));
```

Test (append to the DB class in `test_spray_compliance_importer.py`):

```python
	def test_derive_codes_from_ingredients(self):
		item = frappe.db.get_value("Spray Product", {"product_name": ["like", "Amitiv%"]}, "name")
		doc = frappe.get_doc("Spray Product", item)
		doc.set("frac", [])
		doc.set("active_ingredients", [{"ingredient": "Azoxystrobin"}])
		doc.save()
		self.assertIn("FRAC 11", M.derive_codes(item))
		frappe.db.rollback()
```

Add `upande_scp/public/js/spray_product.js` to this task's commit.

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/spray_compliance/importer.py upande_scp/serverscripts/tests/test_spray_compliance_importer.py upande_scp/serverscripts/spray_compliance/moa_seed.py upande_scp/public/js/spray_product.js
git commit -m "feat(scp): load the roses approved list onto spray products — targets, ingredients, groups"
```

---

### Task 10: Dry-run on kaitet.local — human checkpoint (no code)

- [ ] **Step 1:** `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local migrate`
- [ ] **Step 2:** `bench --site kaitet.local execute upande_scp.serverscripts.spray_compliance.moa_seed.seed --kwargs '{"dry_run": false}'` — record created count.
- [ ] **Step 3:** `bench --site kaitet.local execute upande_scp.serverscripts.spray_compliance.importer.import_roses_sheet` — prints the summary and the report path.
- [ ] **Step 4:** Show the user the summary: matched / unmatched / duplicates / first-word matches / type fixes / unmapped targets. **STOP and wait for the user's go-ahead.** Do not run with `apply` until they say so.
- [ ] **Step 5 (after approval):** `… import_roses_sheet --kwargs '{"apply": true}'`, then re-run the dry run and confirm targets/codes now present (`select count(distinct parent) from \`tabChemical Targets\` where parenttype='Spray Product'` should rise from 43).

---

### Task 11: Frontend API client and pure helpers

**Files:**
- Create: `frontend/src/lib/spray-compliance-api.ts`
- Test: `frontend/src/lib/spray-compliance-api.test.ts`

**Interfaces:**
- Consumes: `call` from `@/lib/frappe`; server shapes from Tasks 4/6/7.
- Produces types `RuleMode`, `Violation`, `CoverageRow`, `CheckResult`, `ProductEligibility`, `BomEligibility`, `OverrideInput`; calls `checkSprayPlan`, `eligibleProducts`, `eligibleBoms`; pure helpers `groupViolations(v) -> {rule, label, items}[]`, `ruleLabel(rule)`, `modeBadge(mode, overridden) -> {text, tone}`, `saveGate(result) -> {state: "ok"|"warn"|"override"|"blocked", reason?: string}`, `sortBoms(boms, eligibility)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  groupViolations,
  modeBadge,
  saveGate,
  sortBoms,
  type CheckResult,
  type Violation,
} from "./spray-compliance-api";

const v = (rule: string, mode: Violation["mode"], overridden = false): Violation => ({
  rule, mode, overridden, message: `${rule} msg`, products: [], targets: [], codes: [], key: `${rule}:k`,
});
const res = (violations: Violation[], extra: Partial<CheckResult> = {}): CheckResult => ({
  violations, coverage: [], blocking: false, needs_override: false, status: "Clean", can_override: false, ...extra,
});

describe("saveGate", () => {
  it("is ok when clean", () => expect(saveGate(res([])).state).toBe("ok"));
  it("warns but allows", () => expect(saveGate(res([v("target_match", "Warn")])).state).toBe("warn"));
  it("blocks on a hard block", () => {
    const g = saveGate(res([v("same_moa_in_mix", "Block")], { blocking: true, status: "Blocked" }));
    expect(g.state).toBe("blocked");
    expect(g.reason).toContain("same_moa_in_mix msg");
  });
  it("asks for an override when only overridable rules block", () =>
    expect(saveGate(res([v("moa_rotation", "Block (GM override)")], { blocking: true, needs_override: true })).state).toBe("override"));
});

describe("groupViolations", () => {
  it("groups by rule in engine order with labels", () => {
    const g = groupViolations([v("tank_mix_incompatible", "Warn"), v("target_match", "Warn"), v("target_match", "Block")]);
    expect(g.map((x) => x.rule)).toEqual(["target_match", "tank_mix_incompatible"]);
    expect(g[0].items).toHaveLength(2);
    expect(g[0].label).toBe("Product targets");
  });
});

describe("modeBadge", () => {
  it("names each state", () => {
    expect(modeBadge("Block", false).text).toBe("Blocked");
    expect(modeBadge("Block (GM override)", false).text).toBe("Needs GM override");
    expect(modeBadge("Block (GM override)", true).text).toBe("Overridden");
    expect(modeBadge("Warn", false).text).toBe("Warning");
  });
});

describe("sortBoms", () => {
  it("puts eligible first and keeps unknown last", () => {
    const boms = [{ name: "A" }, { name: "B" }, { name: "C" }];
    const elig = { A: { eligible: false }, B: { eligible: true } } as never;
    expect(sortBoms(boms, elig).map((b) => b.name)).toEqual(["B", "A", "C"]);
  });
});
```

- [ ] **Step 2: Run** `cd frontend && npx vitest run src/lib/spray-compliance-api.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Spray compliance — the server decides whether a plan's products suit its
 * targets and each other; this module only fetches and presents that decision.
 */
import { call } from "@/lib/frappe";

const M = "upande_scp.serverscripts.spray_compliance.api";

export type RuleMode = "Off" | "Warn" | "Block (GM override)" | "Block";
export interface Violation {
  rule: string; mode: RuleMode; overridden: boolean; message: string;
  products: string[]; targets: string[]; codes: string[]; key: string;
}
export interface CoverageRow { target: string; products: string[] }
export interface CheckResult {
  violations: Violation[]; coverage: CoverageRow[]; blocking: boolean; needs_override: boolean;
  status: "Clean" | "Warnings" | "Awaiting Override" | "Overridden" | "Blocked";
  can_override: boolean;
}
export interface ProductEligibility {
  item: string; name: string; eligible: boolean; worst_mode: RuleMode; reasons: string[];
  codes: string[]; targets: string[]; non_target: boolean;
}
export interface BomEligibility {
  bom: string; eligible: boolean; status: CheckResult["status"]; worst_mode: RuleMode;
  coverage: CoverageRow[]; reasons: string[];
}
export interface OverrideInput { key: string; rule: string; reason: string }

const RULE_ORDER = ["target_match", "target_coverage", "same_moa_in_mix", "moa_rotation",
  "max_sprays", "known_resistance", "tank_mix_incompatible"];
const LABELS: Record<string, string> = {
  target_match: "Product targets", target_coverage: "Target coverage",
  same_moa_in_mix: "Same group in one tank", moa_rotation: "Group rotation",
  max_sprays: "Spray limits", known_resistance: "Known resistance",
  tank_mix_incompatible: "Tank-mix incompatibility",
};

export const ruleLabel = (rule: string) => LABELS[rule] ?? rule;

export function checkSprayPlan(args: {
  greenhouse: string; targets: string[]; items: string[]; overrides?: OverrideInput[]; excludeWo?: string;
}): Promise<CheckResult> {
  return call<CheckResult>(`${M}.check_spray_plan`, {
    greenhouse: args.greenhouse, targets: JSON.stringify(args.targets), items: JSON.stringify(args.items),
    overrides: JSON.stringify(args.overrides ?? []), exclude_wo: args.excludeWo ?? "",
  });
}

export function eligibleProducts(args: {
  greenhouse: string; targets: string[]; items: string[]; candidates?: string[];
}): Promise<ProductEligibility[]> {
  return call<ProductEligibility[]>(`${M}.eligible_products`, {
    greenhouse: args.greenhouse, targets: JSON.stringify(args.targets), items: JSON.stringify(args.items),
    candidates: JSON.stringify(args.candidates ?? []),
  });
}

export function eligibleBoms(args: { greenhouse: string; targets: string[]; boms: string[] }): Promise<BomEligibility[]> {
  return call<BomEligibility[]>(`${M}.eligible_boms`, {
    greenhouse: args.greenhouse, targets: JSON.stringify(args.targets), boms: JSON.stringify(args.boms),
  });
}

export function groupViolations(vs: Violation[]) {
  return RULE_ORDER.map((rule) => ({ rule, label: ruleLabel(rule), items: vs.filter((v) => v.rule === rule) }))
    .filter((g) => g.items.length);
}

export function modeBadge(mode: RuleMode, overridden: boolean): { text: string; tone: "red" | "amber" | "muted" | "green" } {
  if (overridden) return { text: "Overridden", tone: "green" };
  if (mode === "Block") return { text: "Blocked", tone: "red" };
  if (mode === "Block (GM override)") return { text: "Needs GM override", tone: "amber" };
  return { text: "Warning", tone: "muted" };
}

export function saveGate(r: CheckResult | null): { state: "ok" | "warn" | "override" | "blocked"; reason?: string } {
  if (!r) return { state: "ok" };
  const hard = r.violations.filter((v) => v.mode === "Block");
  if (hard.length) return { state: "blocked", reason: hard.map((v) => v.message).join("\n") };
  if (r.needs_override) return { state: "override" };
  return { state: r.violations.length ? "warn" : "ok" };
}

export function sortBoms<T extends { name: string }>(boms: T[], elig: Record<string, { eligible: boolean } | undefined>): T[] {
  const rank = (b: T) => (elig[b.name] === undefined ? 2 : elig[b.name]!.eligible ? 0 : 1);
  return [...boms].sort((a, b) => rank(a) - rank(b));
}
```

- [ ] **Step 4: Run** the vitest command. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/spray-compliance-api.ts frontend/src/lib/spray-compliance-api.test.ts
git commit -m "feat(scp-ui): fetch and read the spray check"
```

---

### Task 12: Creator UI — order, BOM picker, rows, Add chemical, Spray check card, save gate

**Files:**
- Create: `frontend/src/components/spray-plan/SprayCheckCard.tsx`
- Create: `frontend/src/components/spray-plan/OverrideDialog.tsx`
- Modify: `frontend/src/components/BomPicker.tsx`
- Modify: `frontend/src/pages/ApplicationPlan.tsx`
- Modify: `frontend/src/lib/spray-plan-creator-api.ts` (`DraftPayload.spray_rule_overrides?: OverrideInput[]`, response `compliance?: CheckResult`)
- Modify: `frontend/src/components/spray-plan/ApprovalChemicalsTable.tsx`, `ApprovalReview` type gains `compliance?: CheckResult & { overrides: {rule; reason; overridden_by; overridden_on}[] }`

**Interfaces:**
- Consumes: everything exported by Task 11.
- Produces: `<SprayCheckCard result loading readOnly? overrides? productNames />`, `<OverrideDialog open violations onConfirm(overrides: OverrideInput[]) onOpenChange />`, `BomPicker` new optional prop `eligibility?: Record<string, BomEligibility>`.

- [ ] **Step 1: `SprayCheckCard.tsx`**

```tsx
import { CheckCircle2, AlertTriangle, ShieldAlert, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { groupViolations, modeBadge, type CheckResult } from "@/lib/spray-compliance-api";

const TONE: Record<string, string> = {
  red: "text-destructive", amber: "text-amber-700 dark:text-amber-400",
  muted: "text-muted-foreground", green: "text-[var(--sd-data-green)]",
};

export function SprayCheckCard({ result, loading, names, overrides }: {
  result: CheckResult | null; loading: boolean; names: Record<string, string>;
  overrides?: { rule: string; reason: string; overridden_by: string; overridden_on: string }[];
}) {
  const nm = (i: string) => names[i] ?? i;
  return (
    <Card className="p-4">
      <CardHeader className="p-0 pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Spray check</CardTitle>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </CardHeader>
      <CardContent className="p-0 flex flex-col gap-3 text-xs">
        {!result ? (
          <span className="text-muted-foreground">Pick targets and a tank mix to check this plan.</span>
        ) : (
          <>
            {result.coverage.length > 0 && (
              <table className="w-full">
                <tbody>
                  {result.coverage.map((c) => (
                    <tr key={c.target} className="border-b last:border-0">
                      <td className="py-1 font-medium">{c.target}</td>
                      <td className="py-1">
                        {c.products.length ? (
                          <span className="inline-flex items-center gap-1">
                            <CheckCircle2 className="h-3.5 w-3.5 text-[var(--sd-data-green)]" />
                            {c.products.map(nm).join(", ")}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-destructive">
                            <AlertTriangle className="h-3.5 w-3.5" /> Not covered
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {result.violations.length === 0 ? (
              <span className="inline-flex items-center gap-1.5 text-[var(--sd-data-green)]">
                <CheckCircle2 className="h-4 w-4" /> All checks pass
              </span>
            ) : (
              groupViolations(result.violations).map((g) => (
                <div key={g.rule} className="flex flex-col gap-1">
                  <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">{g.label}</div>
                  {g.items.map((v) => {
                    const b = modeBadge(v.mode, v.overridden);
                    return (
                      <div key={v.key} className="flex items-start gap-2">
                        <ShieldAlert className={`h-3.5 w-3.5 mt-[1px] shrink-0 ${TONE[b.tone]}`} />
                        <span className="flex-1">{v.message}</span>
                        <Badge variant="outline" className={`shrink-0 ${TONE[b.tone]}`}>{b.text}</Badge>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
            {overrides && overrides.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">Overrides</div>
                {overrides.map((o, i) => (
                  <div key={i}>{o.reason} <span className="text-muted-foreground">— {o.overridden_by}, {o.overridden_on.slice(0, 16)}</span></div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: `OverrideDialog.tsx`**

```tsx
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ruleLabel, type OverrideInput, type Violation } from "@/lib/spray-compliance-api";

export function OverrideDialog({ open, onOpenChange, violations, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; violations: Violation[];
  onConfirm: (o: OverrideInput[]) => void;
}) {
  const pending = violations.filter((v) => v.mode === "Block (GM override)" && !v.overridden);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  useEffect(() => { if (open) setReasons({}); }, [open]);
  const ready = pending.every((v) => (reasons[v.key] ?? "").trim().length >= 5);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Override spray check</DialogTitle>
          <DialogDescription>Each override is recorded on the plan with your name and reason.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 max-h-[60vh] overflow-auto">
          {pending.map((v) => (
            <label key={v.key} className="flex flex-col gap-1 text-xs">
              <span className="font-medium">{ruleLabel(v.rule)}</span>
              <span className="text-muted-foreground">{v.message}</span>
              <Textarea rows={2} value={reasons[v.key] ?? ""} placeholder="Why this is acceptable for this spray"
                onChange={(e) => setReasons((r) => ({ ...r, [v.key]: e.target.value }))} />
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!ready}
            onClick={() => onConfirm(pending.map((v) => ({ key: v.key, rule: v.rule, reason: reasons[v.key].trim() })))}>
            Override and save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

If `@/components/ui/textarea` does not exist, add it with `npx shadcn@latest add textarea` (the repo has `components.json`).

- [ ] **Step 3: BomPicker eligibility**

In `BomPicker.tsx`, add `eligibility?: Record<string, BomEligibility>` to `BomPickerProps`, sort `shown` with `sortBoms(shown, eligibility ?? {})`, and in each option render, under the name:

```tsx
{eligibility?.[b.name] && (
  eligibility[b.name].eligible ? (
    <div className="text-[0.65rem] text-[var(--sd-data-green)] inline-flex items-center gap-1">
      <CheckCircle2 className="h-3 w-3" />
      covers {eligibility[b.name].coverage.map((c) => c.target).join(", ")}
    </div>
  ) : (
    <div className="text-[0.65rem] text-muted-foreground truncate" title={eligibility[b.name].reasons.join("\n")}>
      {eligibility[b.name].reasons[0]}
    </div>
  )
)}
```

and disable the option (`aria-disabled`, no `onSelect`) when `eligibility?.[b.name]?.worst_mode === "Block"`. Keep keyboard navigation skipping disabled options (adjust the existing `active` index handling to skip them).

- [ ] **Step 4: Wire `ApplicationPlan.tsx`**

1. Move the Targets `<div className="col-span-2">…</div>` block (currently inside the setup card, after Kit) so it renders **before** the "Bill of Materials" card — keep it in the same card but make the Bill of Materials card disabled-looking (`<BomPicker disabled={!selectedTargets.size} …/>`) with helper text "Pick targets first." when none are selected.
2. State + effects:

```tsx
const [bomElig, setBomElig] = useState<Record<string, BomEligibility>>({});
const [check, setCheck] = useState<CheckResult | null>(null);
const [checkLoading, setCheckLoading] = useState(false);
const [overrideOpen, setOverrideOpen] = useState(false);
const targetsArr = useMemo(() => Array.from(selectedTargets).sort(), [selectedTargets]);

useEffect(() => {
  if (!greenhouse || !targetsArr.length || !bomList.length) { setBomElig({}); return; }
  let cancelled = false;
  eligibleBoms({ greenhouse, targets: targetsArr, boms: bomList.map((b) => b.name) })
    .then((rows) => !cancelled && setBomElig(Object.fromEntries(rows.map((r) => [r.bom, r]))))
    .catch(() => !cancelled && setBomElig({}));
  return () => { cancelled = true; };
}, [greenhouse, targetsArr, bomList]);

useEffect(() => {
  if (!greenhouse || !targetsArr.length || !chemRows.length) { setCheck(null); return; }
  let cancelled = false;
  setCheckLoading(true);
  const t = setTimeout(() => {
    checkSprayPlan({ greenhouse, targets: targetsArr, items: chemRows.map((c) => c.item_code) })
      .then((r) => !cancelled && setCheck(r))
      .catch(() => !cancelled && setCheck(null))
      .finally(() => !cancelled && setCheckLoading(false));
  }, 300);
  return () => { cancelled = true; clearTimeout(t); };
}, [greenhouse, targetsArr, chemRows]);
```

Pass `eligibility={bomElig}` to `<BomPicker>`.
3. Chemical rows: next to each row's name, render pills from `check`/eligibility data — the row's targets (intersection of the product's targets with `targetsArr`, from a `productInfo` map filled by an `eligibleProducts({greenhouse, targets: targetsArr, items: [], candidates: chemRows.map(c=>c.item_code)})` call in the same debounced effect) and its `codes`. Pill markup: `<Badge variant="outline" className="text-[0.6rem] px-1.5 py-0">IRAC 5</Badge>`. A row whose item appears in any non-overridden violation's `products` gets `<ShieldAlert className="h-3.5 w-3.5 text-amber-700" />` before the name — no row border colour.
4. Add chemical dialog: when it opens, call `eligibleProducts({ greenhouse, targets: targetsArr, items: chemRows.map(c=>c.item_code), candidates: addResults.map(r=>r.item_code) })` whenever `addResults` changes; sort `addResults` by that order; for ineligible rows render the first reason under the item in `text-muted-foreground` and set `disabled` + `opacity-60` when `worst_mode === "Block"`. Add a "Show all" toggle: when off, hide rows that are `!eligible && !non_target`.
5. Mount `<SprayCheckCard result={check} loading={checkLoading} names={Object.fromEntries(chemRows.map(c=>[c.item_code, c.item_name]))} />` directly after the Chemical Stock matrix card.
6. Save gate — in the submit handler, before building `draftPayload`:

```tsx
const gate = saveGate(check);
if (gate.state === "blocked") { pushToast("err", gate.reason || "This mix is blocked by the spray check."); return; }
if (gate.state === "override" && check?.can_override && !pendingOverrides) { setOverrideOpen(true); return; }
```

with `const [pendingOverrides, setPendingOverrides] = useState<OverrideInput[] | null>(null)`; add `spray_rule_overrides: pendingOverrides ?? []` to `draftPayload`; `OverrideDialog.onConfirm` sets `pendingOverrides`, closes, and re-invokes the submit handler. Clear `pendingOverrides` whenever `check` changes. The Save button label is `"Save — needs GM override"` when `gate.state === "override" && check?.can_override`, `"Save as draft (awaiting override)"` when `gate.state === "override"` and not, and it is `disabled` with `title={gate.reason}` when `gate.state === "blocked"`. After a successful save, if `r.compliance?.status === "Awaiting Override"` show `pushToast("ok", "Saved. An SCP General Manager must override before approval.")`.

- [ ] **Step 5: Approval page**

In `ApprovalChemicalsTable.tsx`, render `<SprayCheckCard result={review.compliance ?? null} loading={false} names={Object.fromEntries(review.chemicals.map(c=>[c.item_code, c.item_name]))} overrides={review.compliance?.overrides} />` above the table, and remove the old `plan_warnings` IRAC/FRAC rotation lines only (keep the rate warning).

- [ ] **Step 6: Build and type-check**

Run: `cd frontend && npx vitest run && yarn build 2>&1 | tail -15`
Expected: tests pass, build succeeds with no TS errors.

- [ ] **Step 7: Browser check on kaitet.local**

Using the `run` skill / Playwright against kaitet.local: open the Rose creator, pick a greenhouse, Curative/Preventive, select `Thrips` + `Powdery Mildew`; confirm (a) BOM picker is disabled before targets, (b) eligible BOMs listed first with "covers …", (c) adding Collis only shows "Thrips — Not covered" in the Spray check card, (d) adding Delegate clears it and shows "All checks pass" (with all rules on Warn and the import applied), (e) set `rule_same_moa_in_mix = Block` in Desk, add Delegate + another IRAC 5 product → Save disabled with reason. Screenshot each. Reset the setting to `Warn` afterwards.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/spray-plan/SprayCheckCard.tsx frontend/src/components/spray-plan/OverrideDialog.tsx frontend/src/components/BomPicker.tsx frontend/src/pages/ApplicationPlan.tsx frontend/src/lib/spray-plan-creator-api.ts frontend/src/components/spray-plan/ApprovalChemicalsTable.tsx
git commit -m "feat(scp-ui): targets choose the tank mix, and the spray check says what is wrong before save"
```

If the build output under `upande_scp/public` is tracked, commit it in the same commit (check `git status` after `yarn build`).
