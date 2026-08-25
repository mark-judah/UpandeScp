# Foliar-aware finance on mona, built on kaitet's crop-protection base

**Date:** 2026-08-25
**Branch:** `mona` (frappe16) · **Site:** `mona.local`
**Status:** design approved, ready for planning

---

## 1. Motivation

Mona's finance report answers "what did each greenhouse spend on chemicals,
broken down by the pest/disease it was spent on". Three independent defects mean
it currently answers a much smaller question than it appears to.

### 1.1 Foliars never enter the spray flow

`upande_scp/serverscripts/create_bom.py:295` filters the product picker with a
hardcoded list:

```python
filters={"item_group": ["in", ["CHEMICALS", "Fertilizer"]], "disabled": 0}
```

On `mona.local` the real Item Groups are **`Chemicals`** (78 items) and
**`Fertilizers`** (26 items). MariaDB's case-insensitive collation forgives
`CHEMICALS` → `Chemicals`; it does not forgive `Fertilizer` → `Fertilizers`.
All 26 foliar items are invisible to the picker.

### 1.2 Finance reads one stock-entry purpose out of four

Submitted movement, all time:

| Purpose | Chemicals | Fertilizers |
|---|---:|---:|
| `Material Transfer for Manufacture` *(the only thing finance reads)* | 5,643,541 | 212,009 |
| `Material Issue` | 5,994,159 | **9,115,186** |
| `Material Transfer` | 1,538,562 | 419,580 |
| `Manufacture` | 26,119 | 300 |

`chemical_cost_by_target` reports ≈**5.62M of ≈22.95M**. Roughly half of all
*chemical* spend also escapes it.

The 9.1M of foliar spend is 437 hand-posted `Material Issue` documents, owner
`stores@monaflowers.co.ke`, all on cost centre `Production - MFK`, none linked to
a Work Order, no project, no remarks. **Mona's foliar operation runs manually
through the store, entirely outside SCP.** There is no greenhouse or target
dimension in that data to recover, at any price.

### 1.3 Most per-target attribution is a fallback artefact

Only **10 of 79** `Chemical` rows have targets populated. When a chemical has no
targets, `finances.py` divides its cost equally across *all* the plan's targets:

| | Lines | Value |
|---|---:|---:|
| Genuinely attributed | 130 | 1,625,484 |
| **Smeared via the fallback** | 1,051 | **3,991,603** |

71% of captured spend is smeared. Multi-target plans are the norm — of 528 Work
Orders only 58 carry one target; 160 carry two, with a tail out to 14. A
14-target plan splits an untargeted chemical into 14 equal slivers. The columns
look precise and are largely an artefact of step 4 of the algorithm.

A foliar hits the same fallback (it has no `Chemical` row), so foliar cost is
currently smeared onto **pest and disease** columns, silently inflating them.

---

## 2. Goals

1. Report the money that is actually spent, not the quarter of it that happens
   to flow through a Work Order.
2. Separate chemical spend from foliar spend reliably, by configuration rather
   than by hardcoded item-group strings.
3. Stop foliars borrowing the plan's pest/disease targets.
4. Raise genuine attribution from 29% toward 77% by seeding `Chemical` metadata
   from the farm's own Plant Protection Products book.
5. Make split (smeared) and untargeted values **visible in the report** rather
   than indistinguishable from measured ones.
6. Land kaitet's crop-protection layer on mona **byte-identical**, so the next
   port is a merge and not another reconciliation.

## 3. Non-goals

- **Per-greenhouse foliar breakdown.** The data does not exist. That requires
  either routing foliars through the spray flow (slice B) or adding a greenhouse
  dimension to store issues (slice C). Both are forward-only and out of scope.
- **Broader UI parity with kaitet.** 83 of 127 shared frontend files differ.
  Only `Finance.tsx` is touched here; the rest is a later slice.
- **Backfilling history.** Nothing re-dates or re-posts existing documents.

---

## 4. Design

### 4.1 Foundation — port kaitet's crop-protection layer verbatim

Ported unmodified from `frappe15/apps/upande_scp` @ `kaitet`:

| Artefact | Note |
|---|---|
| `serverscripts/common/crop_protection.py` | config-driven classification + resolution |
| `Chemical`, `Foliar` doctypes | 1:1 with Item, `autoname: field:item` |
| `Chemical Crop Profile`, `Foliar Crop Profile` | unused on a roses-only site; ported anyway so `_PRODUCTS` iterates without a fork |
| `Crop Protection Item Group` | child of the settings Single |
| `serverscripts/tests/test_crop_protection.py` | ported with the module |

Mona's `Spray Plan Settings` is **kept as-is** and gains
`chemical_item_groups` / `foliar_item_groups`, configured to `Chemicals` /
`Fertilizers`.

> **The settings rename is deliberately out of scope.** Mona's Single has 41
> fields, kaitet's has 66; 35 overlap. Mona holds 6 fields kaitet does not have
> — notably `chemical_stores` and `fertigation_stores`, which on kaitet moved
> into the *Farm Store Mapping* subsystem. Renaming onto kaitet's doctype would
> delete mona's store configuration (depended on by `test_allowed_store_
> warehouses.py`) and drag in 31 kaitet-only fields covering postponements,
> allocation and general-store — three subsystems mona does not have. That is a
> slice of its own.
>
> The single concession to byte-identity: `crop_protection.py` is ported with
> **one line changed**, `SETTINGS = "Spray Plan Settings"`. The module defines
> that as a constant for exactly this reason ("Kept as a constant so a future
> rename touches one place"), so this is its designed seam, not a fork.

Mona's `serverscripts/chemical_meta.py` is **deleted**; it is the same idea one
generation behind. Its callers repoint to `crop_protection`. Field mapping:

| `chemical_meta` | `crop_protection` |
|---|---|
| `application_rate` | *(dropped — no equivalent; audit callers)* |
| `allowed` | *(dropped — gate moves to `Permitted Chemicals`)* |
| `lower_rate_limit` / `upper_rate_limit` | `default_lower_rate_limit` / `default_upper_rate_limit`, overridable per crop |
| `targets` | `default_targets` |

Files that come from kaitet must not be edited during the port, with the single
documented exception of the `SETTINGS` constant above. Where mona needs
different behaviour, the difference goes in a mona-side caller, never in the
ported file.

### 4.2 Fix the picker

`create_bom.py:295` and the sibling filters use
`crop_protection.product_groups()`. Guard the empty-tuple case — an unconfigured
site would otherwise emit `IN ()`, a syntax error.

### 4.3 Seed `Chemical` / `Foliar` from the Plant Protection Products book

Source: `doc references/monadocs/PLANT PROTECTION PRODUCTS And Suppliers.xlsx`.

- **Sheet1** — Mona's own book: 119 products, 10 target sections
- **Sheet2** — *Equator Flowers Kenya Limited*: 97 rows / 96 distinct products, 9 sections

The sheets group products under **target section headers**; that grouping is the
`targets` data.

#### Provenance rule (decided)

| Source | Contributes |
|---|---|
| **Sheet1** | full depth — targets, rates, toxicity, actives, FRAC/IRAC, PCPB, form |
| **Sheet2** | **targets only**, and only for the 8 items Sheet1 does not cover |

Rationale: the sheets agree on targets (56 of 58 overlapping products) but
disagree on **rates in 31 of 58 cases** — MELTATOX 2.5 vs 1.5, NIMROD 2.5–3 vs
2, PREVICUR 2.5 g/l vs 4. A rate is farm-, crop- and water-volume specific and
gates what physically goes in a sprayer. Targets are a property of the molecule
and travel between farms; rates do not. **No Equator rate is ever written.**

#### Coverage

| | Items |
|---|---:|
| Sheet1 covers | 38 / 78 |
| Sheet2 adds | 8 |
| **Union** | **46 / 78** |
| Covered by neither | 32 |

The 32 uncovered items keep no targets and continue to use the equal-split
fallback — flagged in the report (§4.5), never guessed.

#### Targets are resolved by active ingredient, not brand name

Brand names are farm- and supplier-specific; actives are universal. The loader
derives an **active ingredient → targets** map from both sheets (114 distinct
actives) and unions it with the product's own section.

This barely changes coverage (46 → 46 items) but materially improves
correctness: brand-name matching yields **0 multi-target products**, because
each sheet files a product under exactly one heading. Active-ingredient
expansion recovers **7**. Only 9 of 114 actives map to more than one target, and
each is agronomically real:

| Active | Targets |
|---|---|
| azoxystrobin | Botrytis, Downy Mildew, Powdery Mildew |
| buprofezin | Aphids/Mealybugs, Thrips, Caterpillars |
| spinetoram | Caterpillars, Thrips, Aphids/Mealybugs |
| pyrethrins | Aphids, Thrips |
| difenoconazole | Botrytis, Powdery Mildew |
| lufenuron | Caterpillars, Thrips |
| matrine | Spidermites, Thrips |
| monosultap | Aphids/Mealybugs, Thrips |
| sulfoxaflor | Aphids, Aphids/Mealybugs |

This also **resolves the APPLAUD 40% SC conflict** (Sheet1 Aphids/M Bugs vs
Sheet2 Caterpillars): buprofezin is genuinely active across those groups, so the
union is correct and neither sheet needs to lose.

**Rejected:** inferring actives from Item *names*. Tested; it rescued exactly one
item, `SULPHURIC ACID` → "sulphur" → Powdery Mildew, which is wrong (pH
adjustment, not a fungicide). The heuristic is unsafe and is not implemented.

#### Target alias map

A reviewable module constant, not inline string munging:

| Sheet section | Master |
|---|---|
| `Agrobacteria` | Agrobacterium |
| `Downey mildew` | Downy Mildew |
| `Powdery mildew` / `Botrytis` / `Thrips` / `Caterpillars` | exact |
| `Mites` | Spidermites |
| `Aphids/ M Bugs` | Aphids **and** Mealybugs |
| `Nematodes` | **new `Pest` master, created by the loader** |
| `P/harvest` | **skipped — not a pest or disease** |

Masters with no coverage in either sheet: Rust, FCM, Spodoptera, Scale Insects,
Whiteflies.

#### Remaining conflict for agronomist review

`DIPNOY 69 EW` — Sheet1 Botrytis, Sheet2 P/harvest. Likely a post-harvest dip
*against* Botrytis, i.e. both partly right. **Reported, not auto-resolved.**

#### Field-level parsing rules

| Sheet column | Target field | Rule |
|---|---|---|
| `Item Description` | matched to Item | normalise formulation suffix + strength before fuzzy match (cutoff 0.85) |
| `PCPB NO.` | `registration_no` | strip `(CR)` wrapper, keep digits |
| `ACTIVE INGREDIENTS` | `active_ingredients` | split on `+`, strip concentrations, normalise `sulfur`→`sulphur`, `alluminium`→`aluminium`, drop salt suffixes |
| `FRAC/IRAC` | `frac` / `irac` | see §4.4 |
| `Form` | `formulation` | verbatim |
| `Rate m/l or g/l` | `default_lower_rate_limit` / `default_upper_rate_limit` | ranges (`2 - 2.25 g/l`) populate both; a single value populates both equally. **Sheet1 only.** |
| `WHO` | `toxicity` | **Roman-numeral repair required — see below** |
| `FT HML` | *(no field)* | flower-industry hazard band; not loaded |
| `SUPPLIERS`, `MANUFACTURER` | *(no field)* | not loaded |

**Toxicity trap.** The `WHO`, `PCPB` and `FT HML` columns read `11`, `111`, `U`.
These are Roman numerals **II** and **III** flattened by Excel, plus `U`
(unlikely to present acute hazard). Loaded literally into the `I/II/III/IV`
Select they are invalid. Mapping is an explicit, hand-checked table
(`11`→`II`, `111`→`III`, `U`→unset), never a numeric cast. A `111` also appears
in the *FRAC* column under Powdery Mildew — the same mangling leaking across
columns — and must be discarded there.

#### Loader behaviour

Idempotent and **fill-blanks-only**, modelled on kaitet's
`serverscripts/scouting/seed_pests_diseases.py`: it never overwrites a populated
field, so it is safe to re-run and cannot clobber agronomist corrections. It
emits a summary naming the 2 conflicts, the 32 uncovered items, and every value
it declined to write.

`Foliar` rows are auto-created for the 26 `Fertilizers` items.

### 4.4 FRAC / IRAC

144 of 216 sheet rows carry a code; **72 (33%) have none**. 54 distinct groups
appear. FRAC and IRAC share one column and split by target type: **disease →
`frac`, pest → `irac`**.

**42 products are pre-mixed multi-group formulations** (`4 + M 03`, `27 + 11`).
Each becomes *two* child rows. Normalisation strips `FRAC`/`IRAC` prefixes,
fixes the `PRAC`→`FRAC` typo, removes internal spaces (`M 03` → `M3`) and strips
leading zeros (`M 01` → `M1`).

Non-code tokens requiring a discard/translate map before load:
`ADJUVANT`, `BROADRANGE`, `N-3`, `N-UNE`, `NEEMEXTRACT`, `PHT`, `U`, `UNE`.
`UNE`/`N-UNE` mean unclassified and map to no row.

#### Resistance-group coverage, per target

| Target | Code entries | Distinct groups | Note |
|---|---:|---:|---|
| Downy Mildew | 51 | 13 | healthiest rotation |
| Powdery Mildew | 31 | 10 | group 5 ×10 of 31 |
| Botrytis | 28 | 9 | group 9 ×10 of 28 |
| Caterpillars | 27 | 9 | 22A ×6 |
| Thrips | 26 | 13 | healthy |
| **Spidermites** | 9 | 3 | **see below** |
| Aphids/Mealybugs | 7 | 6 | thin book |
| Nematodes | 5 | 4 | mostly unclassified |
| Agrobacterium | 1 | 1 | M1 only |

> **Agronomic finding, for the farm rather than for this build.** Spidermites
> shows 3 "groups" across 9 entries, but 4 of those entries are `ADJUVANT`,
> which is not a mode of action. Real rotation is **10A ×4 and 25A ×1** — two
> effective groups. Mite resistance management on two groups is how both are
> lost. Worth raising with the agronomists independently of this work.

### 4.5 Rewrite `finances.py`

#### Consumption definition

| Purpose | Counted | Why |
|---|---|---|
| `Material Transfer for Manufacture` | yes | store → WIP, the spray flow |
| `Material Issue` | yes | direct consumption, currently invisible |
| `Manufacture` | **no** | consumes WIP — double-counts MTfM |
| `Material Transfer` | **no** | store → store, internal movement, not spend |

Reported spend moves from ≈5.62M to ≈**20.96M**. This is a deliberate,
explained change in meaning, not a bug fix — it must be called out in the UI and
to the finance users, or the jump will read as data corruption.

#### Dimensions

- **kind** — `chemical` | `foliar`, via `crop_protection.classify_item_group`.
- **attribution** — pest/disease where a Work Order supplies plan targets;
  otherwise cost centre, bucketed as `Unattributed`.

#### Attribution algorithm

Per stock-entry **line** (not per plan), unchanged in shape from today:

1. Plan targets = the WO's `custom_targets`, filtered to real `Pest` /
   `Plant Disease` names (husbandry ops like `Re-bending` are dropped).
2. Intersect with the product's own `default_targets`.
3. Non-empty → split that line's `amount` equally across the intersection,
   marked **`attributed`**.
4. Empty **and the product is a chemical** → split equally across all plan
   targets, marked **`split`**.
5. Empty **and the product is a foliar** → the whole amount goes to the
   **`Nutrition`** bucket, marked `attributed`. *Foliars never borrow pest
   targets.* This is the core correctness fix.
6. No plan targets at all (every `Material Issue` line) → `Unattributed`,
   grouped by cost centre.

Equal splitting is an **attribution convention, not a measurement**. One tank is
sprayed at one rate; no dose-per-target figure exists anywhere in the data. The
report must never imply otherwise — hence §4.6.

Worked example, `MFG-WO-2026-00008` (Main GH 04, targets *Spidermites* +
*Downy Mildew*):

| Chemical | Amount | Own targets | Attribution |
|---|---:|---|---|
| CHE00043 | 9,547.48 | Downy Mildew | all → Downy Mildew, `attributed` |
| CHE00058 | 2,078.72 | *none* | 1,039.36 each, **`split`** |
| CHE00025 | 3,437.09 | *none* | 1,718.55 each, **`split`** |

Spidermites 2,757.91 · Downy Mildew 12,305.39 · total 15,063.29.

#### Payload

Each cell carries its provenance so the client can render it, rather than the
client re-deriving it:

```
cell: {
  value: float,
  attributed: float,        # from step 3/5
  split: float,             # from step 4 — the smeared portion
  split_items: [item_code]  # chemicals with no targets that contributed
}
```

`split_items` is what powers "which chemicals don't have targets" in the UI.

### 4.6 `Finance.tsx`

- Chemical / foliar split, with foliar spend shown in its own right rather than
  folded into pest columns.
- **Split values are highlighted.** Any cell whose `split > 0` is visually
  marked, with the split proportion and the contributing untargeted chemicals
  available on the cell. A reader must never mistake a smeared number for a
  measured one.
- **A standing panel lists the chemicals that have no targets** — the 32
  uncovered items plus anything new — since that list is the actionable backlog
  for the agronomists, and it shrinks as they fill it in.
- An `Unattributed` section that names the ~9.1M of store-issued foliar spend
  explicitly, with a note that it carries no greenhouse dimension, rather than
  hiding or fabricating one.
- Per house style: **no vertical accent strips or coloured left-border bars.**
  Convey the split/untargeted state through icon or text colour, or a pill.

---

## 5. Migration

Ordered, each step independently reversible:

1. `add_crop_protection_item_groups` — install the `Crop Protection Item Group`
   child doctype and add the two Table MultiSelect fields to `Spray Plan
   Settings`. **No doctype rename.**
2. `introduce_chemical_foliar_doctypes` — install masters + profiles, create
   `Foliar` rows for the 26 `Fertilizers` items.
3. `configure_crop_protection_item_groups` — seed `Chemicals` / `Fertilizers`,
   resolved via `frappe.db.get_value("Item Group", …)` and deduped.
4. `seed_chemicals_from_ppp_book` — the §4.3 loader.
5. Reader cutover: `create_bom`, `finances`, and every `chemical_meta` caller.

## 6. Gotchas carried over from kaitet

Recorded in `frappe15 docs/audits/2026-07-22-chemical-foliar-doctype.md`; all
apply here.

1. **Doctype rename** — *not performed in this slice* (see §4.1), but recorded
   for the slice that does it: the controller class must equal
   `name.replace(" ","")` *preserving case*
   (`ScoutingandCropProtectionSettings`, lowercase "and"). Wrong casing makes
   `get_controller` raise `ImportError`, and migrate then **orphan-deletes the
   doctype on every run**. `rename_doc` updates child `parenttype` but **not**
   `parent` — child rows must be repointed or `get_single` loads no children.
2. **Custom Field delete ≠ column drop** — a separate `ALTER TABLE … DROP COLUMN`
   patch is required.
3. **`Chemical.name == item code`** — child-table queries filtered by `parent`
   alone double-count Item vs sidecar rows; always filter by `parenttype`.
4. **MariaDB case-insensitive collation** — this is the same class of bug that
   caused §1.1. Seeding a `Chemicals` group can match an existing `CHEMICALS`
   and create a duplicate config row. Resolve names through the Item Group
   table and dedupe.

## 7. Testing

- Port `test_crop_protection.py` unchanged.
- Loader tests: Roman-numeral repair; multi-group FRAC splitting; rate ranges;
  fill-blanks-only never overwrites; Sheet2 never supplies a rate; `P/harvest`
  skipped; `Nematodes` created once on re-run.
- Active-ingredient map tests: the 9 ambiguous actives resolve to their full
  target set; `SULPHURIC ACID` gains **no** target.
- Finance tests on fixtures covering each attribution branch, including a foliar
  with no targets landing in `Nutrition` and never in a pest column.
- **Reconciliation invariant:** for any period, the sum of every cell equals the
  sum of source line `amount`s. This is what stops an attribution change quietly
  losing money, and it must hold for `split` values too.
- Tests need `bench --site mona.local set-config allow_tests true`.

## 8. Risks

| Risk | Mitigation |
|---|---|
| The 4× jump in reported spend reads as corruption | called out in the UI and in the release note; the old figure is reproducible by filtering to MTfM |
| Settings fields collide with mona's existing Single | fields are added, never removed; a migrate dry-run confirms mona's 6 unique fields survive |
| A wrong seeded rate reaches a sprayer | Sheet1-only for rates; fill-blanks-only; rate limits are advisory bounds, still validated at plan time |
| Fuzzy product matching mis-assigns a target | 0.85 cutoff, every fuzzy match logged for review, actives cross-check the section |
| Foliars still show no greenhouse breakdown | explicit in the UI; slices B and C are the fix, not this one |

## 9. Follow-ups (explicitly not in this slice)

- **Slice B** — route foliars through the spray flow so they gain a greenhouse
  and target dimension going forward.
- **Slice C** — add a greenhouse dimension to store-issued fertilizer.
- **Slice 2** — broader `Finance.tsx`-adjacent UI parity with kaitet (83
  differing files).
- **Settings convergence** — rename `Spray Plan Settings` to `Scouting and Crop
  Protection Settings`, which requires porting Farm Store Mapping first.
- Push the finance feature *back* to kaitet, which has no finance code at all.
- Fill targets for the 32 uncovered chemicals, and codes for the 72 sheet rows
  with no FRAC/IRAC.
- Raise the Spidermites two-group rotation finding with the agronomists.
