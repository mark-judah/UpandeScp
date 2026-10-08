# Spray Compliance: every pest gets its product, every mix is checked

**Date:** 2026-10-08
**Status:** Design approved in conversation; awaiting written-spec review
**Scope:** Phase 1 of 3 (targets + FRAC/IRAC + tank-mix compatibility). Phase 2 is
pest life-stage efficacy; phase 3 is weather. Both are out of scope here.

## Why

Spray plans today let the creator put any product in the tank. The targets picked
on a plan (`custom_targets`) are validated as *observed* but never connected to
the chemicals. The FRAC/IRAC guideline engine
(`spray_plan_ops/validate_frac_irac_guidelines.validateGuidelines`) exists but has
**no callers**, so no resistance rule has ever been enforced. The approval page's
resistance warnings (`approval_review._detect_resistance_warnings`) read codes
from `parenttype='Item'`, which has been empty since the Chemical/Foliar sidecar
migration, so they are blind too.

The goal is a tighter process: each pest points to the products registered for
it, mixes are checked for mode-of-action (MoA) sense and physical compatibility,
and the server enforces it so no client can bypass it. The aim is preventing
outbreaks and resistance, not paperwork.

## Facts this design rests on (kaitet.local, 2026-10-08)

- `Spray Product` (autoname `field:item`, category Chemical/Foliar) already has
  `default_targets` (Chemical Targets: pest | disease), `irac` / `frac` (Table
  MultiSelect of IRAC/FRAC Code Filter), `active_ingredients`, `type`.
- Coverage is thin: 714 active products; 43 with targets, 21 with IRAC, 21 with
  FRAC, 35 with active ingredients.
- `FRAC Code` (78), `IRAC Code` (64) masters exist. `FRAC Guideline` /
  `IRAC Guideline` records carry free-string parameters, e.g. Alternate MoA = `2`,
  Max Number Of Sprays = `Tebuconazole:2:14`, Target With Known Resistance =
  `Powdery Mildew:11`, `Thrips:UN\nMealybugs:UN`.
- The **kit** (`Spray Equipment Details`) only sets the WO's WIP warehouse. Chemicals
  come from the **Tank Mix BOM** (`get_bom_details`) plus operator edits and
  "Add chemical"; they land in `Work Order.required_items`. 2,447 active BOMs; the
  picker filters by farm only.
- Plans are written only by `spray_plan_creator/drafts.py`
  (`create_draft_spray_plan`, `update_draft_plan` → `_validate_payload`).
  Approval: `spray_plan_ops/spray_plan_approval.approve_single_work_order` and
  `spray_plan_creator/bulk.approve_drafts_bulk`.
- Per-crop settings: `Scouting and Crop Protection Settings` (Single) is the
  default; `crop_settings.OVERRIDABLE` lists the fields a crop may override.
- Seed source: `doc references/CHemicals/Crop Protection Agents + Target Pest.xlsx`
  — Karen Roses Ravine approved list (Jan 2026), 50 rows: trade name, PCPB reg no,
  active ingredient(s) with concentration, target pest text, crop. No FRAC/IRAC.

## Decisions

| # | Decision |
|---|---|
| D1 | One pure rule module on existing data (approach A). No new rule doctype. |
| D2 | Target matching is strict both ways: every pest-control product must target a selected target, and every selected target must be covered. |
| D3 | Non-target products (Adjuvant, pH Buffer, Sticker, PGR, and all Foliars) are exempt from target matching but still subject to tank-mix incompatibility. |
| D4 | Compatibility = same MoA group within one mix **and** rotation vs greenhouse history **and** an agronomist-maintained pairwise incompatibility list. |
| D5 | Enforcement mode is per rule, set in settings, overridable per crop: `Off`, `Warn`, `Block (GM override)`, `Block`. |
| D6 | Active Ingredient → FRAC/IRAC code is its own reusable list; product codes are derived from it. |
| D7 | Guideline parameter strings are read as they are. Standardising them into typed rule types is deferred (noted, not built). |
| D8 | Ship every rule in `Warn`; tighten per rule/per crop from settings once data is reviewed. |

## 1. Data

### 1.1 New: `Active Ingredient MoA` (doctype, non-single)

Autoname `field:ingredient`. Fields:

- `ingredient` (Data, unique) — canonical name, e.g. `Azoxystrobin`.
- `aliases` (Small Text) — one per line, e.g. `Kresoxim-Methyl`, `Kresoxim methyl`.
- `kind` (Select: Fungicide, Insecticide, Bactericide, Biological, PGR, Adjuvant, Other).
- `frac_code` (Link FRAC Code), `irac_code` (Link IRAC Code) — at most one meaningful.
- `notes` (Small Text) — e.g. source table version.

Seeded from FRAC Code List 2024 and IRAC MoA v11 for the ingredients in use only.
Biologicals: Bt kurstaki → IRAC 11A; HearNPV / CrleGV → IRAC 31; Beauveria,
Lecanicillium → IRAC UNF. Codes not yet in the FRAC/IRAC Code masters are created.

A product's effective codes = the union of its active ingredients' codes, written
to `Spray Product.irac` / `.frac` by the importer and by a "Derive codes" button.
Existing hand-entered codes are kept (fill-blanks-only).

### 1.2 New: `Tank Mix Incompatibility` (child of the settings Single)

Fields: `product_a`, `product_b` (Link Spray Product, optional), `ingredient_a`,
`ingredient_b` (Link Active Ingredient MoA, optional), `reason` (Small Text,
required). A row matches if both sides are present in the mix, each side matched by
product **or** by ingredient. Starts empty; maintained by the agronomist.

### 1.3 New: rule modes on `Scouting and Crop Protection Settings`

New section "Spray Rules", one Select per rule, options
`Off / Warn / Block (GM override) / Block`, default `Warn`:

`rule_target_match`, `rule_target_coverage`, `rule_same_moa_in_mix`,
`rule_moa_rotation`, `rule_max_sprays`, `rule_known_resistance`,
`rule_tank_mix_incompatible`.

All seven are added to `crop_settings.OVERRIDABLE` (reason: "Product data and
resistance pressure differ by crop; roses can be strict while avocado data is
still being filled.").

### 1.4 New: `Spray Rule Override` (child of Work Order, field `custom_spray_rule_overrides`)

Fields: `rule`, `subject` (products/codes involved), `reason` (required),
`overridden_by` (Link User), `overridden_on` (Datetime). Added as a Custom Field
fixture on Work Order, like the other `custom_*` WO fields.

### 1.5 Roses import

`spray_compliance/importer.py`, run via `bench execute`:

- `import_roses_sheet(path, apply=False)` — dry run returns and writes a report
  (HTML + CSV in the site's private files): per row the matched Spray Product(s),
  target mapping, parsed active ingredients, derived codes, type fixes, and the
  unmatched/duplicate list.
- `apply=True` writes, fill-blanks-only, idempotent.
- Product matching: normalised trade name (uppercase, strip formulation suffix
  like `250 SC`, `WG`, punctuation) against `product_name`, then registration no.
  Duplicates (Gladius, Lecatech, Meltatox, Sivanto, Thuricide) all receive the data
  and are listed for cleanup; unmatched rows (B-NINE, CRYPTOGRAN, MOSSIPLAN,
  TEPPEKI) are reported, never created.
- Target mapping: split on `,`, `&`, ` and `; then a fixed map —
  `Caterpillars (Helicoverpa)`/`Bollworms`/`Helicoverpa` → Helicoverpa;
  `Caterpillars (Spodoptera)`/`Spodoptera` → Spodoptera; `Caterpillars` → Caterpillars;
  `Spidermites`, `Thrips`, `Aphids`, `Whiteflies`, `Mealybugs`, `FCM` → same-named
  Pest; `Botrytis`, `Powdery Mildew`, `Downy Mildew`, `Agrobacterium` → same-named
  Plant Disease. `Adjuvant`, `Plant Growth Regulator` → no target, product type set
  accordingly. `Soil borne fungal diseases` → reported unmapped (Rizolex left
  without a target until a catalog entry is decided).
- Type fixes: products whose derived codes are FRAC-only but typed Insecticide
  (Disarm, Orvego) are corrected to Fungicide and reported.
- Registration no. is written to `registration_no` when blank.

## 2. Engine — `upande_scp/serverscripts/spray_compliance/`

Pure functions take plain dicts; a thin loader fetches from the DB. This keeps the
rules unit-testable without a site.

```
spray_compliance/
  context.py    # load_context(plan) -> dict: products, codes, targets, history, settings
  rules.py      # one pure function per rule: (ctx) -> list[Violation]
  engine.py     # check_mix(ctx) / eligible_products(ctx); mode resolution
  api.py        # whitelisted endpoints
  importer.py   # roses sheet import
```

`Violation = {rule, mode, products: [...], targets: [...], codes: [...], message}`.

### 2.1 Rules (phase 1)

| Rule | Fires when | Data |
|---|---|---|
| `target_match` | a pest-control product targets none of the plan's targets | `default_targets` |
| `target_coverage` | a plan target is covered by no product in the mix | `default_targets` |
| `same_moa_in_mix` | two products in the mix share a FRAC or IRAC code (UN/UNE/UNF/NC/M-groups excluded) | product codes |
| `moa_rotation` | a code would be used more than N consecutive sprays on this greenhouse (N = Alternate MoA guideline parameter) | history |
| `max_sprays` | a product exceeds `Chemical:Sprays:RequiredBreakInDays` | history + guideline |
| `known_resistance` | a product's code is listed against a plan target (`Target:Code`) | guideline |
| `tank_mix_incompatible` | a pair in the mix matches an incompatibility row | §1.2 |

"Pest-control product" = Spray Product with category `Chemical` and type **not** in
{`Adjuvant`, `pH Buffer`, `Plant Growth Regulator`}. A blank type counts as
pest-control (386 Chemicals are untyped today): being strict means an untyped
product surfaces as a `target_match` warning instead of slipping through. Every
`Foliar` is non-target regardless of its type (42 Foliars are typed Insecticide
today; that is data noise, not intent). `Plant Growth Regulator` is added to the
`type` Select options (needed for B-NINE).

History = the greenhouse's Application Floor Plan WOs in workflow states Approved,
Chemical Issued, Tank Mix Manufactured, Spraying In Progress, Completed, ordered by
`custom_scheduled_application_time`, excluding the plan being checked, within the
crop's `irac_rotation_window_days` / `frac_rotation_window_days`. Codes come from
Spray Product, never Item.

### 2.2 Modes

`engine.resolve_mode(rule, crop)` reads the crop-resolved setting. `Off` rules are
not evaluated. Result of `check_mix`:

```
{ "violations": [...], "blocking": bool, "needs_override": bool,
  "coverage": [{target, products: [...]}] }
```

`blocking` = any violation in `Block`, or any in `Block (GM override)` not covered
by a matching override in the payload.

### 2.3 Enforcement points

1. `drafts._validate_payload` (create + update): build ctx from the payload, run
   `check_mix`. `blocking` → `frappe.throw` listing every message. Warn-only →
   save and return `compliance_warnings`. Overrides in the payload are accepted
   only from users with **SCP General Manager**; others may save a plan that
   `needs_override` as a draft with `custom_compliance_status = "Awaiting Override"`.
2. Approval (`approve_single_work_order`, `approve_drafts_bulk`): re-run against
   the stored WO (history may have moved). Blocking → refuse that WO (bulk reports
   it per row and continues with the others).
3. `api.check_spray_plan(payload)` — read-only, same result shape, for live UI.
4. `api.eligible_products(targets, crop, greenhouse, bom=None)` — every Spray
   Product with `{eligible, reasons[], codes, targets, non_target}`; with `bom`,
   per-row eligibility for that BOM's items.
5. `api.eligible_boms(targets, crop, greenhouse, farm)` — the farm's BOMs with
   coverage summary and reasons, sorted eligible-first.

`approval_review._detect_resistance_warnings` is replaced by the engine's result
(fixes the blind Item-sourced codes). The dead `validateGuidelines` endpoint stays
in place untouched; its rule logic is reimplemented in `rules.py`, and removal is a
separate cleanup.

## 3. UI — `frontend/src/pages/ApplicationPlan.tsx`

- **Order:** Targets moves above Tank Mix. The BOM picker is disabled until at
  least one target is chosen.
- **BOM picker:** fed by `eligible_boms`. Eligible first with "covers Thrips ✓
  Powdery Mildew ✓"; ineligible under a collapsed "N not suitable" group, each with
  a one-line reason. Selectable per mode (Block: no; GM override: yes, flagged;
  Warn: yes).
- **Chemical rows:** a target pill (or a neutral `Adjuvant`/`Foliar` pill) and MoA
  code pill(s) (`IRAC 5`, `FRAC 11`). A violating row gets a status icon and
  coloured text — no coloured left-border strips.
- **Add chemical:** picker fed by `eligible_products`; matching first, rule-breakers
  greyed with reason, non-matching only behind "Show all" when the rule mode allows.
- **Spray check card:** debounced `check_spray_plan` on every target/row change.
  Coverage grid (target → products, ✓ or gap) and violations grouped by rule with a
  mode badge (Blocked / Needs GM override / Warning). Clean state: check-in-circle
  icon + "All checks pass".
- **Save:** disabled with a reason while `blocking` and the user cannot override.
  GM sees "Save — needs GM override" → dialog with one reason field per overridable
  violation. Non-GM saves a draft marked Awaiting Override.
- **Approval page:** the same card read-only, plus the stored overrides.
- **Settings:** the Spray Rules section, the incompatibility table and the Active
  Ingredient MoA list are Desk forms; no React settings page in this phase.

RN mobile app: out of scope (it does not create plans; the server enforces).

## 4. Rollout

1. Deploy with all rules `Warn`. Run importer dry run → review → apply.
2. Seed `Active Ingredient MoA`; derive codes.
3. Watch warnings 1–2 weeks; fix data (duplicates, unmatched, avocado/coffee).
4. Tighten per rule per crop in settings — no deploy.

## 5. Testing

- `test_spray_compliance_rules.py`: each rule as a pure function, including
  exemptions (adjuvant, foliar), excluded groups (M, UN), rotation counting across
  history + current mix, alias matching for ingredients.
- `test_spray_compliance_engine.py`: mode resolution incl. per-crop override;
  blocking/needs_override logic; override acceptance by role.
- `test_spray_compliance_importer.py`: name normalisation, target splitting/mapping,
  code derivation, fill-blanks-only, idempotency — against a small fixture sheet.
- Integration: `_validate_payload` and approval paths per mode.
- Manual: browser check of the creator on kaitet.local.
- Note: the full `bench run-tests --app upande_scp` cannot bootstrap on kaitet.local
  ("Parent Department: All Departments"); run module-level tests.

## Out of scope / later

- Phase 2: pest life-stage efficacy (product × stage; mix must cover scouted
  stages; distinguish real life stages from signs like Damage/Web).
- Phase 3: weather.
- Standardising guideline parameters into typed rule records (D7).
- Avocado/coffee product data; BOM list cleanup; removing `validateGuidelines`.
