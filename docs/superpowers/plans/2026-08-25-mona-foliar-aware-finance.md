# Foliar-Aware Finance (mona) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mona's finance report count all chemical and foliar spend, classify the two reliably by configuration, and show which figures are measured versus split across targets.

**Architecture:** Port kaitet's config-driven crop-protection layer (`crop_protection.py`, `Chemical`/`Foliar` sidecars) into mona byte-identical except one constant; seed chemical metadata from the farm's Plant Protection Products book using active ingredients as the target key; then widen `finances.py` from one stock-entry purpose to two and add `kind` + attribution-provenance dimensions that the report surfaces.

**Tech Stack:** Frappe/ERPNext v16 (py3.14), MariaDB, React + TypeScript + shadcn/ui, `openpyxl` for the seed loader.

**Spec:** `docs/superpowers/specs/2026-08-25-mona-foliar-aware-finance-design.md`

## Global Constraints

- **Site is `mona.local`** in the `frappe16` bench. Never query the Kaitet MCP; use `bench --site mona.local`.
- **Files ported from kaitet must not be edited**, with one documented exception: `crop_protection.py`'s `SETTINGS = "Spray Plan Settings"`.
- **No doctype renames.** `Spray Plan Settings` keeps its name.
- **Item Groups are `Chemicals` and `Fertilizers`** — plural, capitalised. Never hardcode them; resolve through `product_groups()`.
- **The seed loader is fill-blanks-only and idempotent.** It never overwrites a populated field.
- **Sheet2 (Equator Flowers) may supply targets only** — never a rate, toxicity, or any other value.
- **No commits unless the user explicitly asks** (project CLAUDE.md). Steps below say "stage", not "push".
- **No `Co-Authored-By` trailer** in any commit message.
- **UI: no vertical accent strips or coloured left-border bars.** Use icon/text colour or a pill.
- Enable tests once: `bench --site mona.local set-config allow_tests true`.
- Test command shape: `bench --site mona.local run-tests --app upande_scp --module upande_scp.serverscripts.tests.<module>`

---

## File Structure

| File | Responsibility |
|---|---|
| `upande_scp/upande_scp/doctype/crop_protection_item_group/` | child doctype naming an Item Group (ported) |
| `upande_scp/upande_scp/doctype/foliar/` | foliar sidecar master (ported) |
| `upande_scp/upande_scp/doctype/{chemical,foliar}_crop_profile/` | per-crop overrides (ported, unused on roses) |
| `upande_scp/serverscripts/common/crop_protection.py` | **the** answer to "chemical or foliar?" (ported, 1 line changed) |
| `upande_scp/serverscripts/ppp_book/parse.py` | pure parsing of the PPP workbook — no DB access |
| `upande_scp/serverscripts/ppp_book/seed.py` | writes parsed data into `Chemical`/`Foliar` |
| `upande_scp/serverscripts/finances.py` | rewritten: two purposes, `kind` + provenance |
| `frontend/src/lib/finance-api.ts` | payload types incl. split provenance |
| `frontend/src/pages/Finance.tsx` | split highlighting + untargeted panel |

`parse.py` is split from `seed.py` deliberately: parsing is where the Roman numerals, mixed FRAC codes and rate ranges live, and it is the part worth testing exhaustively without a database.

---

### Task 1: Item-group configuration

**Files:**
- Create: `upande_scp/upande_scp/doctype/crop_protection_item_group/` (copy from kaitet)
- Modify: `upande_scp/upande_scp/doctype/spray_plan_settings/spray_plan_settings.json`
- Create: `upande_scp/patches/v1_0/configure_crop_protection_item_groups.py`
- Modify: `upande_scp/patches.txt`
- Test: `upande_scp/serverscripts/tests/test_crop_protection.py` (ported from kaitet)

**Interfaces:**
- Consumes: nothing.
- Produces: `Spray Plan Settings.chemical_item_groups` / `.foliar_item_groups`, both `Table MultiSelect` of `Crop Protection Item Group` (field `item_group`, Link to Item Group).

- [ ] **Step 1: Copy the child doctype from kaitet**

```bash
K=/home/ubuntu/stive/code/frappe15/apps/upande_scp/upande_scp/upande_scp/doctype
M=/home/ubuntu/stive/code/frappe16/apps/upande_scp/upande_scp/upande_scp/doctype
cp -r "$K/crop_protection_item_group" "$M/crop_protection_item_group"
```

- [ ] **Step 2: Add the two fields to Spray Plan Settings**

Append to the `fields` array of `spray_plan_settings.json`, after `keywords_section`:

```json
{"fieldname": "cp_groups_section", "fieldtype": "Section Break", "label": "Crop Protection Item Groups"},
{"fieldname": "chemical_item_groups", "fieldtype": "Table MultiSelect", "label": "Chemical Item Groups", "options": "Crop Protection Item Group"},
{"fieldname": "foliar_item_groups", "fieldtype": "Table MultiSelect", "label": "Foliar Item Groups", "options": "Crop Protection Item Group"}
```

Add all three fieldnames to `field_order` in the same position.

- [ ] **Step 3: Write the failing test**

Create `upande_scp/serverscripts/tests/test_crop_protection.py` by copying kaitet's, then confirm it contains a classification case. Add this mona-specific test:

```python
def test_mona_item_groups_are_configured(self):
    from upande_scp.serverscripts.common import crop_protection
    self.assertIn("Chemicals", crop_protection.chemical_groups())
    self.assertIn("Fertilizers", crop_protection.foliar_groups())
    self.assertEqual(crop_protection.classify_item_group("Fertilizers"), "foliar")
    self.assertEqual(crop_protection.classify_item_group("Chemicals"), "chemical")
    self.assertIsNone(crop_protection.classify_item_group("Chemical Mix"))
```

- [ ] **Step 4: Run it and watch it fail**

Run: `bench --site mona.local run-tests --app upande_scp --module upande_scp.serverscripts.tests.test_crop_protection`
Expected: FAIL — `crop_protection` does not exist yet (Task 2 supplies it). This test is written now and stays red until Task 2; that is intentional and noted here so the implementer does not "fix" it early.

- [ ] **Step 5: Write the configuration patch**

Create `upande_scp/patches/v1_0/configure_crop_protection_item_groups.py`:

```python
"""Point the crop-protection classifier at mona's real Item Groups.

The groups are resolved through the Item Group table rather than written as
literals: MariaDB's collation is case-insensitive, so seeding "Chemicals" can
silently match an existing "CHEMICALS" and create a duplicate config row.
"""
from __future__ import annotations

import frappe

WANTED = {"chemical_item_groups": "Chemicals", "foliar_item_groups": "Fertilizers"}


def execute():
    settings = frappe.get_single("Spray Plan Settings")
    changed = False
    for field, wanted in WANTED.items():
        resolved = frappe.db.get_value("Item Group", {"name": wanted}, "name")
        if not resolved:
            frappe.log_error(f"Item Group {wanted!r} not found", "configure_crop_protection_item_groups")
            continue
        existing = {r.item_group for r in (settings.get(field) or [])}
        if resolved in existing:
            continue
        settings.append(field, {"item_group": resolved})
        changed = True
    if changed:
        settings.save(ignore_permissions=True)
```

- [ ] **Step 6: Register the patch**

Append to `upande_scp/patches.txt` under `[post_model_sync]`:

```
upande_scp.patches.v1_0.configure_crop_protection_item_groups
```

- [ ] **Step 7: Migrate and verify the config landed**

```bash
cd /home/ubuntu/stive/code/frappe16 && bench --site mona.local migrate
bench --site mona.local mariadb --skip-column-names -e "
SELECT parentfield, item_group FROM \`tabCrop Protection Item Group\` ORDER BY parentfield;"
```

Expected: exactly two rows — `chemical_item_groups / Chemicals` and `foliar_item_groups / Fertilizers`. Two rows, not four: a duplicate means the collation guard failed.

- [ ] **Step 8: Stage**

```bash
git add upande_scp/upande_scp/doctype/crop_protection_item_group \
        upande_scp/upande_scp/doctype/spray_plan_settings/spray_plan_settings.json \
        upande_scp/patches/v1_0/configure_crop_protection_item_groups.py \
        upande_scp/patches.txt
```

---

### Task 2: Port the crop-protection layer

**Files:**
- Create: `upande_scp/serverscripts/common/__init__.py`, `upande_scp/serverscripts/common/crop_protection.py`
- Create: `upande_scp/upande_scp/doctype/foliar/`, `chemical_crop_profile/`, `foliar_crop_profile/`
- Test: `upande_scp/serverscripts/tests/test_crop_protection.py`

**Interfaces:**
- Consumes: Task 1's settings fields.
- Produces: `crop_protection.product_groups(kind=None) -> tuple[str,...]`, `classify_item_group(g) -> 'chemical'|'foliar'|None`, `is_foliar_group(g) -> bool`, `is_chemical(code) -> bool`, `is_foliar(code) -> bool`, `get_chemical(code) -> Document|None`, `get_foliar(code) -> Document|None`.

- [ ] **Step 1: Copy the module and doctypes from kaitet**

```bash
K=/home/ubuntu/stive/code/frappe15/apps/upande_scp/upande_scp
M=/home/ubuntu/stive/code/frappe16/apps/upande_scp/upande_scp
mkdir -p "$M/serverscripts/common" && touch "$M/serverscripts/common/__init__.py"
cp "$K/serverscripts/common/crop_protection.py" "$M/serverscripts/common/"
for d in foliar chemical_crop_profile foliar_crop_profile; do cp -r "$K/upande_scp/doctype/$d" "$M/upande_scp/doctype/$d"; done
```

- [ ] **Step 2: Apply the one permitted edit**

In `upande_scp/serverscripts/common/crop_protection.py`, change the `SETTINGS` constant and extend its comment:

```python
# The settings Single. Kept as a constant so a future rename touches one place.
# mona still calls this "Spray Plan Settings"; kaitet renamed it to
# "Scouting and Crop Protection Settings". This constant is the only permitted
# divergence from kaitet's copy of this file.
SETTINGS = "Spray Plan Settings"
```

- [ ] **Step 3: Confirm that is the ONLY difference**

```bash
diff /home/ubuntu/stive/code/frappe15/apps/upande_scp/upande_scp/serverscripts/common/crop_protection.py \
     /home/ubuntu/stive/code/frappe16/apps/upande_scp/upande_scp/serverscripts/common/crop_protection.py
```

Expected: one hunk, touching only the `SETTINGS` line and its comment. Any other hunk must be reverted.

- [ ] **Step 4: Migrate, then run Task 1's test**

```bash
cd /home/ubuntu/stive/code/frappe16 && bench --site mona.local migrate
bench --site mona.local run-tests --app upande_scp --module upande_scp.serverscripts.tests.test_crop_protection
```

Expected: PASS, including `test_mona_item_groups_are_configured`.

- [ ] **Step 5: Stage**

```bash
git add upande_scp/serverscripts/common upande_scp/serverscripts/tests/test_crop_protection.py \
        upande_scp/upande_scp/doctype/foliar upande_scp/upande_scp/doctype/chemical_crop_profile \
        upande_scp/upande_scp/doctype/foliar_crop_profile
```

---

### Task 3: Create Foliar rows for the 26 Fertilizers items

**Files:**
- Create: `upande_scp/patches/v1_0/backfill_foliar_master.py`
- Modify: `upande_scp/patches.txt`
- Test: `upande_scp/serverscripts/tests/test_foliar_backfill.py`

**Interfaces:**
- Consumes: `crop_protection.product_groups("foliar")`, the `Foliar` doctype.
- Produces: one `Foliar` per Fertilizers Item, named by item code (`autoname: field:item`).

- [ ] **Step 1: Write the failing test**

```python
import frappe
from frappe.tests.utils import FrappeTestCase
from upande_scp.serverscripts.common import crop_protection


class TestFoliarBackfill(FrappeTestCase):
    def test_every_fertilizer_item_has_a_foliar_row(self):
        groups = list(crop_protection.product_groups("foliar"))
        self.assertTrue(groups, "foliar item groups are not configured")
        items = frappe.get_all("Item", filters={"item_group": ["in", groups], "disabled": 0}, pluck="name")
        self.assertTrue(items, "no fertilizer items found on this site")
        missing = [i for i in items if not frappe.db.exists("Foliar", {"item": i})]
        self.assertEqual(missing, [], f"items with no Foliar row: {missing}")

    def test_backfill_is_idempotent(self):
        from upande_scp.patches.v1_0 import backfill_foliar_master
        before = frappe.db.count("Foliar")
        backfill_foliar_master.execute()
        self.assertEqual(frappe.db.count("Foliar"), before)
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bench --site mona.local run-tests --app upande_scp --module upande_scp.serverscripts.tests.test_foliar_backfill`
Expected: FAIL — 26 items listed as having no Foliar row.

- [ ] **Step 3: Write the patch**

```python
"""Create one `Foliar` sidecar per Item in the configured foliar groups.

Mirrors `backfill_chemical_master`, but there are no legacy `custom_*` foliar
fields on Item to copy — mona never had them — so rows are created with the
item link and name only. Metadata arrives later from the PPP book loader.
Idempotent and failure-isolated.
"""
from __future__ import annotations

import frappe

from upande_scp.serverscripts.common import crop_protection


def execute():
    groups = list(crop_protection.product_groups("foliar"))
    if not groups:
        return
    items = frappe.get_all(
        "Item",
        filters={"item_group": ["in", groups], "disabled": 0},
        fields=["name", "item_name"],
    )
    for it in items:
        if frappe.db.exists("Foliar", {"item": it.name}):
            continue
        try:
            frappe.get_doc({
                "doctype": "Foliar",
                "item": it.name,
                "foliar_name": it.item_name or it.name,
            }).insert(ignore_permissions=True)
        except Exception:
            frappe.log_error(frappe.get_traceback(), f"backfill_foliar_master: {it.name}")
```

- [ ] **Step 4: Register and migrate**

Append to `patches.txt` under `[post_model_sync]`:

```
upande_scp.patches.v1_0.backfill_foliar_master
```

Then: `cd /home/ubuntu/stive/code/frappe16 && bench --site mona.local migrate`

- [ ] **Step 5: Run the tests**

Run: `bench --site mona.local run-tests --app upande_scp --module upande_scp.serverscripts.tests.test_foliar_backfill`
Expected: PASS. Confirm the count: `bench --site mona.local mariadb --skip-column-names -e "SELECT COUNT(*) FROM \`tabFoliar\`;"` → 26.

- [ ] **Step 6: Stage**

```bash
git add upande_scp/patches/v1_0/backfill_foliar_master.py upande_scp/patches.txt \
        upande_scp/serverscripts/tests/test_foliar_backfill.py
```

---

### Task 4: Make the picker see foliars

**Files:**
- Modify: `upande_scp/serverscripts/create_bom.py:268`, `:295`, `:319`
- Test: `upande_scp/serverscripts/tests/test_get_all_chemicals.py`

**Interfaces:**
- Consumes: `crop_protection.product_groups`, `crop_protection.is_foliar_group`.
- Produces: `getAllChemicals()` returning a non-empty `fertilizers` list.

**Context:** this is the defect that kept 26 foliar items out of the spray flow — `["CHEMICALS", "Fertilizer"]` never matched `Fertilizers`.

- [ ] **Step 1: Write the failing test**

```python
import frappe
from frappe.tests.utils import FrappeTestCase


class TestGetAllChemicals(FrappeTestCase):
    def test_fertilizers_are_returned(self):
        from upande_scp.serverscripts.create_bom import getAllChemicals
        result = getAllChemicals()
        self.assertTrue(result["chemicals"], "no chemicals returned")
        self.assertTrue(result["fertilizers"], "no fertilizers returned — the item-group filter is wrong")

    def test_no_hardcoded_group_literals_remain(self):
        import inspect
        from upande_scp.serverscripts import create_bom
        src = inspect.getsource(create_bom)
        for literal in ('"CHEMICALS"', "'CHEMICALS'", '"Fertilizer"', "'Fertilizer'"):
            self.assertNotIn(literal, src, f"hardcoded item group {literal} still present")
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bench --site mona.local run-tests --app upande_scp --module upande_scp.serverscripts.tests.test_get_all_chemicals`
Expected: FAIL — `no fertilizers returned`.

- [ ] **Step 3: Replace the three hardcoded filters**

At the top of `create_bom.py`:

```python
from upande_scp.serverscripts.common.crop_protection import is_foliar_group, product_groups
```

Line ~268 (`get_chemical_rate_limits`):

```python
filters={"item_group": ["in", list(product_groups("chemical"))], "disabled": 0},
```

Line ~295 (`getAllChemicals`):

```python
filters={"item_group": ["in", list(product_groups())], "disabled": 0},
```

Line ~319:

```python
item_type = "fertilizer" if is_foliar_group(it.item_group) else "chemical"
```

- [ ] **Step 4: Run the tests**

Run: `bench --site mona.local run-tests --app upande_scp --module upande_scp.serverscripts.tests.test_get_all_chemicals`
Expected: PASS — 78 chemicals and 26 fertilizers.

- [ ] **Step 5: Stage**

```bash
git add upande_scp/serverscripts/create_bom.py upande_scp/serverscripts/tests/test_get_all_chemicals.py
```

---

### Task 5: Parse the PPP workbook (pure, no database)

**Files:**
- Create: `upande_scp/serverscripts/ppp_book/__init__.py`, `upande_scp/serverscripts/ppp_book/parse.py`
- Test: `upande_scp/serverscripts/tests/test_ppp_parse.py`

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces:
  - `split_actives(s: str) -> list[str]`
  - `normalise_codes(s: str) -> list[str]`
  - `repair_toxicity(s: str) -> str | None`
  - `parse_rate(s: str) -> tuple[float|None, float|None]`
  - `TARGET_ALIASES: dict[str, list[str]]`
  - `parse_workbook(path: str) -> list[dict]` with keys `sheet, product, key, targets, actives, codes, toxicity, rate_low, rate_high, formulation, registration_no`
  - `active_target_map(rows) -> dict[str, set[str]]`

- [ ] **Step 1: Write the failing tests**

```python
import unittest
from upande_scp.serverscripts.ppp_book import parse


class TestPPPParse(unittest.TestCase):
    def test_split_actives_strips_concentrations(self):
        self.assertEqual(
            parse.split_actives("Metalaxyl-M 40g/Kg + Mancozeb 640g/Kg"),
            ["metalaxyl-m", "mancozeb"],
        )

    def test_split_actives_normalises_spelling(self):
        self.assertEqual(parse.split_actives("Sulfur 800 g/kg"), ["sulphur"])

    def test_normalise_codes_splits_premixed(self):
        self.assertEqual(parse.normalise_codes("4 + M 03"), ["4", "M3"])
        self.assertEqual(parse.normalise_codes("M 01"), ["M1"])

    def test_normalise_codes_fixes_prac_typo(self):
        self.assertEqual(parse.normalise_codes("PRAC 33 + FRAC 11"), ["33", "11"])

    def test_normalise_codes_drops_non_codes(self):
        for junk in ("ADJUVANT", "BROADRANGE", "NEEMEXTRACT", "PHT", "UNE", "N-UNE", "U", "111"):
            self.assertEqual(parse.normalise_codes(junk), [], f"{junk} should be dropped")

    def test_repair_toxicity_roman_numerals(self):
        self.assertEqual(parse.repair_toxicity("11"), "II")
        self.assertEqual(parse.repair_toxicity("111"), "III")
        self.assertIsNone(parse.repair_toxicity("U"))
        self.assertIsNone(parse.repair_toxicity("-"))
        self.assertIsNone(parse.repair_toxicity("N/A"))

    def test_parse_rate_range_and_single(self):
        self.assertEqual(parse.parse_rate("2 - 2.25 g/l"), (2.0, 2.25))
        self.assertEqual(parse.parse_rate("2 g/l"), (2.0, 2.0))
        self.assertEqual(parse.parse_rate(""), (None, None))

    def test_target_aliases_cover_the_awkward_sections(self):
        self.assertEqual(parse.TARGET_ALIASES["downey mildew"], ["Downy Mildew"])
        self.assertEqual(parse.TARGET_ALIASES["mites"], ["Spidermites"])
        self.assertEqual(parse.TARGET_ALIASES["aphids/ m bugs"], ["Aphids", "Mealybugs"])
        self.assertEqual(parse.TARGET_ALIASES["p/harvest"], [])

    def test_active_target_map_recovers_multi_target_actives(self):
        rows = parse.parse_workbook(parse.DEFAULT_WORKBOOK)
        amap = parse.active_target_map(rows)
        self.assertEqual(
            set(amap["azoxystrobin"]), {"Botrytis", "Downy Mildew", "Powdery Mildew"}
        )
        self.assertIn("Thrips", amap["pyrethrins"])

    def test_workbook_shape_is_as_surveyed(self):
        rows = parse.parse_workbook(parse.DEFAULT_WORKBOOK)
        self.assertEqual(len(rows), 216)
        self.assertEqual(sum(1 for r in rows if r["sheet"] == "Sheet1"), 119)
```

- [ ] **Step 2: Run and watch it fail**

Run: `bench --site mona.local run-tests --app upande_scp --module upande_scp.serverscripts.tests.test_ppp_parse`
Expected: FAIL — `ModuleNotFoundError: upande_scp.serverscripts.ppp_book`.

- [ ] **Step 3: Implement `parse.py`**

```python
"""Pure parsing of the Plant Protection Products workbook.

No database access — everything here is testable without a site. The workbook
groups products under target section headers (a row with only column A filled);
that grouping is the targets data.

Sheet1 is Mona's own book. Sheet2 is Equator Flowers Kenya Limited's; it may
contribute targets only, never a rate (the two farms disagree on rates for 31 of
58 shared products).
"""
from __future__ import annotations

import re

import openpyxl

DEFAULT_WORKBOOK = (
    "/home/ubuntu/stive/code/frappe15/apps/upande_scp/"
    "doc references/monadocs/PLANT PROTECTION PRODUCTS And Suppliers.xlsx"
)

MONA_SHEET = "Sheet1"

# Sheet section header -> master names. An empty list means "not a pest or
# disease" and the section's products contribute no targets.
TARGET_ALIASES = {
    "agrobacteria": ["Agrobacterium"],
    "downey mildew": ["Downy Mildew"],
    "downy mildew": ["Downy Mildew"],
    "powdery mildew": ["Powdery Mildew"],
    "botrytis": ["Botrytis"],
    "mites": ["Spidermites"],
    "thrips": ["Thrips"],
    "aphids": ["Aphids"],
    "aphids/ m bugs": ["Aphids", "Mealybugs"],
    "caterpillars": ["Caterpillars"],
    "nematodes": ["Nematodes"],
    "p/harvest": [],
}

# WHO hazard column: Excel flattened Roman numerals to digits.
TOXICITY_REPAIR = {"1": "I", "11": "II", "111": "III", "1111": "IV",
                   "I": "I", "II": "II", "III": "III", "IV": "IV"}

_FORMULATIONS = ("ec", "wg", "wp", "sc", "sl", "wdg", "sp", "od", "ew", "cs", "me", "gr", "dc", "se", "fs")


def norm_product(s) -> str:
    """Comparison key for a product name: no strength, no formulation suffix."""
    s = re.sub(r"[^a-z0-9 ]", " ", str(s).lower())
    s = re.sub(r"\b(%s)\b" % "|".join(_FORMULATIONS), " ", s)
    s = re.sub(r"\b\d+(\.\d+)?\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def split_actives(s) -> list[str]:
    """Individual active ingredients, lower-cased, concentrations removed."""
    if not s:
        return []
    out = []
    for part in re.split(r"\s*\+\s*", str(s).replace("%", " ")):
        part = re.sub(r"\d+(\.\d+)?\s*(g|kg|mg|ml|l)\s*/\s*(l|kg|ha|g)", "", part, flags=re.I)
        part = re.sub(r"\d+(\.\d+)?\s*w\s*/\s*[wv]", "", part, flags=re.I)
        part = re.sub(r"[\d.]+", "", part)
        part = re.sub(r"\b(g|kg|l|ml|w|v)\b", "", part, flags=re.I)
        part = re.sub(r"[^a-zA-Z\- ]", " ", part)
        part = re.sub(r"\s+", " ", part).strip().lower()
        part = part.replace("sulfur", "sulphur").replace("alluminium", "aluminium")
        part = re.sub(r"\b(hydrochloride|hydrochlride|hcl)\b", "", part).strip()
        if len(part) > 3:
            out.append(part)
    return out


def normalise_codes(s) -> list[str]:
    """FRAC/IRAC codes. Pre-mixed products yield one entry per group.

    Everything that is not a resistance code is dropped: ADJUVANT, BROADRANGE,
    NEEMEXTRACT, PHT are descriptions; UNE / N-UNE mean unclassified; U and 111
    are Roman-numeral toxicity values that leaked across columns.
    """
    if not s:
        return []
    text = str(s).upper().replace("PRAC", "FRAC")
    text = re.sub(r"\b(FRAC|IRAC)\b", " ", text)
    out = []
    for part in re.split(r"\s*\+\s*", text):
        part = part.strip().replace(" ", "").replace("-", "")
        if not part or part in ("N/A", "NA", "NONE", "U", "UNE", "NUNE", "111", "11"):
            continue
        m = re.fullmatch(r"([A-Z]?)0*(\d+)([A-Z]?)", part)
        if m:
            out.append(f"{m.group(1)}{int(m.group(2))}{m.group(3)}")
    return out


def repair_toxicity(s):
    """WHO hazard class, or None when absent/unusable."""
    if s is None:
        return None
    key = str(s).strip().upper()
    if key in ("", "-", "N/A", "NA", "U"):
        return None
    return TOXICITY_REPAIR.get(key)


def parse_rate(s):
    """(low, high) from a rate cell. A single value fills both."""
    if not s:
        return (None, None)
    nums = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", str(s))]
    if not nums:
        return (None, None)
    if len(nums) == 1:
        return (nums[0], nums[0])
    return (min(nums[:2]), max(nums[:2]))


def _is_section_header(col_a, rest) -> bool:
    return bool(col_a) and not rest and not col_a.replace(".", "").isdigit()


def parse_workbook(path: str = DEFAULT_WORKBOOK) -> list[dict]:
    """One dict per product row, in workbook order."""
    wb = openpyxl.load_workbook(path, data_only=True)
    rows = []
    for ws in wb.worksheets:
        is_mona = ws.title == MONA_SHEET
        code_col, form_col, rate_col = (5, 6, 7) if is_mona else (6, 7, 8)
        section = None
        for r in ws.iter_rows(min_row=3, values_only=True):
            col_a = str(r[0]).strip() if r[0] is not None else ""
            rest = [v for v in r[1:] if v not in (None, "")]
            if _is_section_header(col_a, rest):
                section = col_a
                continue
            if not section or not r[1]:
                continue
            low, high = parse_rate(r[rate_col]) if is_mona else (None, None)
            rows.append({
                "sheet": ws.title,
                "product": str(r[1]).strip(),
                "key": norm_product(r[1]),
                "section": section,
                "targets": TARGET_ALIASES.get(section.lower().strip(), []),
                "actives": split_actives(r[4]),
                "codes": normalise_codes(r[code_col]),
                "toxicity": repair_toxicity(r[9]) if is_mona else None,
                "rate_low": low,
                "rate_high": high,
                "formulation": str(r[form_col] or "").strip() or None,
                "registration_no": re.sub(r"[^0-9]", "", str(r[2] or "")) or None,
            })
    return rows


def active_target_map(rows) -> dict[str, set[str]]:
    """active ingredient -> every target any product containing it treats.

    This is what recovers multi-target activity: each sheet files a product
    under exactly one heading, so product-name matching alone yields no
    multi-target products at all.
    """
    out: dict[str, set[str]] = {}
    for r in rows:
        for a in r["actives"]:
            out.setdefault(a, set()).update(r["targets"])
    return out
```

- [ ] **Step 4: Run the tests**

Run: `bench --site mona.local run-tests --app upande_scp --module upande_scp.serverscripts.tests.test_ppp_parse`
Expected: PASS, all 11.

- [ ] **Step 5: Stage**

```bash
git add upande_scp/serverscripts/ppp_book upande_scp/serverscripts/tests/test_ppp_parse.py
```

---

### Task 6: Seed Chemical / Foliar from the parsed book

**Files:**
- Create: `upande_scp/serverscripts/ppp_book/seed.py`
- Test: `upande_scp/serverscripts/tests/test_ppp_seed.py`

**Interfaces:**
- Consumes: everything Task 5 produces.
- Produces: `seed_from_book(path=None, dry_run=False) -> dict` with keys `matched, targets_written, conflicts, uncovered, skipped_existing`. Whitelisted so it can be run from `bench execute`.

- [ ] **Step 1: Write the failing tests**

```python
import frappe
from frappe.tests.utils import FrappeTestCase


class TestPPPSeed(FrappeTestCase):
    def test_dry_run_reports_expected_coverage(self):
        from upande_scp.serverscripts.ppp_book import seed
        report = seed.seed_from_book(dry_run=True)
        self.assertEqual(report["matched"], 46)
        self.assertEqual(len(report["uncovered"]), 32)

    def test_sulphuric_acid_gains_no_target(self):
        """Name-based active inference is rejected: sulphuric acid is a pH
        adjuster, not a sulphur fungicide."""
        from upande_scp.serverscripts.ppp_book import seed
        report = seed.seed_from_book(dry_run=True)
        self.assertIn("CHE00006", report["uncovered"])

    def test_equator_sheet_never_supplies_a_rate(self):
        from upande_scp.serverscripts.ppp_book import parse, seed
        rows = parse.parse_workbook(parse.DEFAULT_WORKBOOK)
        for r in rows:
            if r["sheet"] != parse.MONA_SHEET:
                self.assertEqual((r["rate_low"], r["rate_high"]), (None, None))
                self.assertIsNone(r["toxicity"])

    def test_seed_is_fill_blanks_only(self):
        from upande_scp.serverscripts.ppp_book import seed
        name = frappe.db.get_value("Chemical", {"item": "CHE00043"}, "name")
        doc = frappe.get_doc("Chemical", name)
        doc.formulation = "SENTINEL"
        doc.save(ignore_permissions=True)
        seed.seed_from_book()
        self.assertEqual(frappe.db.get_value("Chemical", name, "formulation"), "SENTINEL")

    def test_nematodes_pest_is_created_once(self):
        from upande_scp.serverscripts.ppp_book import seed
        seed.seed_from_book()
        seed.seed_from_book()
        self.assertEqual(frappe.db.count("Pest", {"name": "Nematodes"}), 1)

    def test_dipnoy_conflict_is_reported_not_resolved(self):
        from upande_scp.serverscripts.ppp_book import seed
        report = seed.seed_from_book(dry_run=True)
        self.assertTrue(any("DIPNOY" in c["product"].upper() for c in report["conflicts"]))
```

- [ ] **Step 2: Run and watch it fail**

Run: `bench --site mona.local run-tests --app upande_scp --module upande_scp.serverscripts.tests.test_ppp_seed`
Expected: FAIL — `seed` module does not exist.

- [ ] **Step 3: Implement `seed.py`**

```python
"""Seed Chemical / Foliar metadata from the Plant Protection Products book.

Fill-blanks-only and idempotent: an existing value is never overwritten, so
agronomist corrections survive a re-run and the loader is safe to run repeatedly.

Targets are resolved by ACTIVE INGREDIENT as well as by the product's own
section. Each sheet files a product under exactly one heading, so section
matching alone yields no multi-target products; the active-ingredient map
recovers genuine broad-spectrum activity (azoxystrobin treats Botrytis, Downy
and Powdery Mildew; spinetoram treats caterpillars, thrips and aphids).

Provenance rule: Sheet1 (Mona) supplies every field. Sheet2 (Equator Flowers)
supplies targets only — the two farms disagree on rates for 31 of 58 shared
products, and a rate gates what physically goes in a sprayer.
"""
from __future__ import annotations

import difflib

import frappe

from upande_scp.serverscripts.common import crop_protection
from upande_scp.serverscripts.ppp_book import parse

FUZZY_CUTOFF = 0.85


def _item_index(kind):
    groups = list(crop_protection.product_groups(kind))
    if not groups:
        return {}
    items = frappe.get_all(
        "Item", filters={"item_group": ["in", groups], "disabled": 0},
        fields=["name", "item_name"],
    )
    return {parse.norm_product(i.item_name or i.name): i.name for i in items}


def _resolve(key, index, keys):
    if key in index:
        return index[key], "exact"
    match = difflib.get_close_matches(key, keys, n=1, cutoff=FUZZY_CUTOFF)
    return (index[match[0]], "fuzzy") if match else (None, None)


def _ensure_pest(name):
    if not frappe.db.exists("Pest", name):
        frappe.get_doc({"doctype": "Pest", "pest_name": name}).insert(ignore_permissions=True)


def _fill(doc, field, value):
    """Set only when the field is currently blank. Returns True if written."""
    if value in (None, "") or doc.get(field):
        return False
    doc.set(field, value)
    return True


@frappe.whitelist()
def seed_from_book(path=None, dry_run=False):
    rows = parse.parse_workbook(path or parse.DEFAULT_WORKBOOK)
    amap = parse.active_target_map(rows)

    chem_index = _item_index("chemical")
    foliar_index = _item_index("foliar")
    chem_keys, foliar_keys = list(chem_index), list(foliar_index)

    # code -> {"targets": set, "row": mona row or None}
    resolved: dict[str, dict] = {}
    conflicts = []
    seen_sections: dict[str, set] = {}

    for r in rows:
        is_mona = r["sheet"] == parse.MONA_SHEET
        code, _how = _resolve(r["key"], chem_index, chem_keys)
        kind = "chemical"
        if not code:
            code, _how = _resolve(r["key"], foliar_index, foliar_keys)
            kind = "foliar"
        if not code:
            continue

        targets = set(r["targets"])
        for a in r["actives"]:
            targets |= amap.get(a, set())

        entry = resolved.setdefault(code, {"kind": kind, "targets": set(), "row": None})
        entry["targets"] |= targets
        if is_mona and entry["row"] is None:
            entry["row"] = r

        prior = seen_sections.setdefault(code, set())
        if prior and r["section"] not in prior:
            conflicts.append({"product": r["product"], "item": code,
                              "sections": sorted(prior | {r["section"]})})
        prior.add(r["section"])

    report = {
        "matched": len(resolved),
        "targets_written": 0,
        "conflicts": conflicts,
        "uncovered": sorted(set(chem_index.values()) - set(resolved)),
        "skipped_existing": 0,
    }
    if dry_run:
        return report

    pests = set(frappe.get_all("Pest", pluck="name"))
    diseases = set(frappe.get_all("Plant Disease", pluck="name"))

    for code, entry in resolved.items():
        master = "Chemical" if entry["kind"] == "chemical" else "Foliar"
        name = frappe.db.get_value(master, {"item": code}, "name")
        if not name:
            continue
        try:
            doc = frappe.get_doc(master, name)
            dirty = False

            if not doc.get("default_targets"):
                for t in sorted(entry["targets"]):
                    if t == "Nematodes":
                        _ensure_pest(t)
                        pests.add(t)
                    if t in pests:
                        doc.append("default_targets", {"pest": t})
                        dirty = True
                    elif t in diseases:
                        doc.append("default_targets", {"disease": t})
                        dirty = True
                if dirty:
                    report["targets_written"] += 1
            else:
                report["skipped_existing"] += 1

            row = entry["row"]
            if row:
                dirty |= _fill(doc, "registration_no", row["registration_no"])
                dirty |= _fill(doc, "formulation", row["formulation"])
                dirty |= _fill(doc, "toxicity", row["toxicity"])
                dirty |= _fill(doc, "default_lower_rate_limit", row["rate_low"])
                dirty |= _fill(doc, "default_upper_rate_limit", row["rate_high"])
                if not doc.get("active_ingredients"):
                    for a in row["actives"]:
                        doc.append("active_ingredients", {"ingredient": a})
                        dirty = True
                code_field = "irac" if entry["targets"] & pests else "frac"
                if not doc.get(code_field):
                    for c in row["codes"]:
                        doc.append(code_field, {"code": c})
                        dirty = True

            if dirty:
                doc.save(ignore_permissions=True)
        except Exception:
            frappe.log_error(frappe.get_traceback(), f"seed_from_book: {code}")

    return report
```

- [ ] **Step 4: Run the tests**

Run: `bench --site mona.local run-tests --app upande_scp --module upande_scp.serverscripts.tests.test_ppp_seed`
Expected: PASS.

> If `test_dry_run_reports_expected_coverage` reports a number other than 46, do **not** loosen the assertion. The figure was measured against this workbook and this site; a different number means the matcher changed behaviour and needs investigating.

- [ ] **Step 5: Run it for real and read the report**

```bash
cd /home/ubuntu/stive/code/frappe16
bench --site mona.local execute upande_scp.serverscripts.ppp_book.seed.seed_from_book
bench --site mona.local mariadb --skip-column-names -e "
SELECT CASE WHEN t.n>0 THEN 'has targets' ELSE 'NO targets' END AS s, COUNT(*) AS c
FROM \`tabChemical\` c
LEFT JOIN (SELECT parent, COUNT(*) n FROM \`tabChemical Targets\` WHERE parenttype='Chemical' GROUP BY parent) t
  ON t.parent=c.name GROUP BY s;"
```

Expected: `has targets` rises from 10 toward 46. Note the `parenttype='Chemical'` filter — `Chemical.name` equals the item code, so filtering by `parent` alone double-counts Item and sidecar rows.

- [ ] **Step 6: Stage**

```bash
git add upande_scp/serverscripts/ppp_book/seed.py upande_scp/serverscripts/tests/test_ppp_seed.py
```

---

### Task 7: Rewrite `finances.py`

**Files:**
- Modify: `upande_scp/serverscripts/finances.py` (full rewrite)
- Test: `upande_scp/serverscripts/tests/test_finances.py`

**Interfaces:**
- Consumes: `crop_protection.classify_item_group`, `crop_protection.get_chemical`, `crop_protection.get_foliar`.
- Produces: `chemical_cost_by_target(from_date, to_date, farm=None) -> dict`:

```
{
  as_of, currency, grand_total,
  totals_by_kind: {chemical: float, foliar: float},
  farms: [{
    farm, targets,
    rows: [{greenhouse, kind, costs: {target: cell}, total}],
    target_totals: {target: float}, total
  }],
  unattributed: [{cost_center, kind, value}],
  untargeted_items: [{item_code, item_name, kind, value}]
}
```

where `cell` is `{value, attributed, split, split_items: [item_code]}`.

**Context:** consumption becomes `Material Transfer for Manufacture` **plus** `Material Issue`. `Manufacture` is excluded (it consumes WIP and would double-count MTfM) and `Material Transfer` is excluded (store-to-store, not spend). Reported spend rises from ≈5.62M to ≈20.96M — a deliberate change of meaning.

- [ ] **Step 1: Write the failing tests**

```python
import frappe
from frappe.tests.utils import FrappeTestCase

FROM_DATE, TO_DATE = "2020-01-01", "2030-12-31"


class TestFinances(FrappeTestCase):
    def setUp(self):
        from upande_scp.serverscripts import finances
        self.report = finances.chemical_cost_by_target(FROM_DATE, TO_DATE)

    def test_cells_reconcile_to_their_row_total(self):
        for farm in self.report["farms"]:
            for row in farm["rows"]:
                cells = sum(c["value"] for c in row["costs"].values())
                self.assertAlmostEqual(cells, row["total"], places=2)

    def test_every_cell_splits_into_attributed_plus_split(self):
        for farm in self.report["farms"]:
            for row in farm["rows"]:
                for cell in row["costs"].values():
                    self.assertAlmostEqual(
                        cell["attributed"] + cell["split"], cell["value"], places=2
                    )

    def test_material_issue_spend_is_counted(self):
        """The 9.1M of store-issued foliar was invisible before this change."""
        self.assertTrue(self.report["unattributed"], "no unattributed spend reported")
        self.assertGreater(sum(u["value"] for u in self.report["unattributed"]), 0)

    def test_foliar_never_lands_in_a_pest_column(self):
        pests = set(frappe.get_all("Pest", pluck="name"))
        diseases = set(frappe.get_all("Plant Disease", pluck="name"))
        for farm in self.report["farms"]:
            for row in farm["rows"]:
                if row["kind"] != "foliar":
                    continue
                for target, cell in row["costs"].items():
                    if cell["value"]:
                        self.assertNotIn(target, pests | diseases,
                                         f"foliar cost landed on {target}")

    def test_split_cells_name_the_untargeted_chemicals(self):
        found = False
        for farm in self.report["farms"]:
            for row in farm["rows"]:
                for cell in row["costs"].values():
                    if cell["split"] > 0:
                        found = True
                        self.assertTrue(cell["split_items"],
                                        "a split cell must name its untargeted items")
        self.assertTrue(found, "expected at least one split cell on this dataset")

    def test_untargeted_items_are_listed(self):
        self.assertTrue(self.report["untargeted_items"])
        for entry in self.report["untargeted_items"]:
            self.assertIn(entry["kind"], ("chemical", "foliar"))

    def test_excluded_purposes_do_not_inflate_the_total(self):
        total = frappe.db.sql("""
            SELECT ROUND(SUM(sed.amount),2) FROM `tabStock Entry` se
            JOIN `tabStock Entry Detail` sed ON sed.parent=se.name
            JOIN `tabItem` i ON i.name=sed.item_code
            WHERE se.docstatus=1
              AND se.purpose IN ('Material Transfer for Manufacture','Material Issue')
              AND i.item_group IN ('Chemicals','Fertilizers')
        """)[0][0]
        self.assertAlmostEqual(self.report["grand_total"], float(total), delta=1.0)
```

- [ ] **Step 2: Run and watch it fail**

Run: `bench --site mona.local run-tests --app upande_scp --module upande_scp.serverscripts.tests.test_finances`
Expected: FAIL — `KeyError: 'unattributed'`, and `costs` values are floats, not dicts.

- [ ] **Step 3: Rewrite `finances.py`**

Replace the whole file. Key changes from the current version:

1. Import `crop_protection`, drop `chemical_meta`.
2. Widen the SQL to both purposes with a `LEFT JOIN` on Work Order (a `Material Issue` has none), and carry `sed.cost_center` and `i.item_group`.
3. Classify each line with `classify_item_group(item_group)`.
4. Resolve targets from `default_targets` on the `Chemical`/`Foliar` sidecar.
5. Apply the six-branch attribution from spec §4.5, recording `attributed` / `split` / `split_items` per cell.
6. Accumulate `unattributed` (no plan targets) by cost centre and `untargeted_items` (product with no `default_targets`) by item.

```python
SQL = """
    SELECT sed.item_code, sed.amount, sed.cost_center,
           i.item_group, i.item_name,
           wo.custom_greenhouse AS greenhouse, wo.custom_targets AS targets,
           COALESCE(gh.custom_farm, '') AS farm
    FROM `tabStock Entry` se
    JOIN `tabStock Entry Detail` sed ON sed.parent = se.name
    JOIN `tabItem` i ON i.name = sed.item_code
    LEFT JOIN `tabWork Order` wo ON wo.name = se.work_order
    LEFT JOIN `tabWarehouse` gh ON gh.name = wo.custom_greenhouse
    WHERE se.docstatus = 1
      AND se.purpose IN ('Material Transfer for Manufacture', 'Material Issue')
      AND se.posting_date BETWEEN %(f)s AND %(t)s
      AND i.item_group IN %(groups)s
"""
```

with `groups = crop_protection.product_groups()` — and an early return when that tuple is empty, since `IN ()` is a MariaDB syntax error.

The attribution core:

```python
def _attribute(line, kind, product_targets, plan_targets):
    """Return (buckets, marked_split). See spec 4.5."""
    if kind == "foliar":
        relevant = [t for t in plan_targets if t in product_targets]
        if relevant:
            return relevant, False
        return [NUTRITION], False        # foliars never borrow pest targets
    relevant = [t for t in plan_targets if t in product_targets]
    if relevant:
        return relevant, False
    if plan_targets:
        return plan_targets, True        # the smear — must be marked
    return [], False                     # caller routes to Unattributed
```

Each bucket receives `amount / len(buckets)`; when `marked_split` the share is added to `cell["split"]` and the item code appended to `cell["split_items"]`, otherwise to `cell["attributed"]`. `cell["value"]` is the sum of both. Round only at output so cells reconcile to row totals.

- [ ] **Step 4: Run the tests**

Run: `bench --site mona.local run-tests --app upande_scp --module upande_scp.serverscripts.tests.test_finances`
Expected: PASS, all 7.

- [ ] **Step 5: Sanity-check the new headline against the survey**

```bash
cd /home/ubuntu/stive/code/frappe16 && bench --site mona.local execute \
  upande_scp.serverscripts.finances.chemical_cost_by_target \
  --kwargs '{"from_date":"2020-01-01","to_date":"2030-12-31"}' | tail -5
```

Expected: `grand_total` ≈ 20,964,895 (was ≈5,616,787). A materially different figure means a purpose filter is wrong.

- [ ] **Step 6: Stage**

```bash
git add upande_scp/serverscripts/finances.py upande_scp/serverscripts/tests/test_finances.py
```

---

### Task 8: Surface splits and untargeted chemicals in the UI

**Files:**
- Modify: `frontend/src/lib/finance-api.ts`
- Modify: `frontend/src/pages/Finance.tsx`

**Interfaces:**
- Consumes: Task 7's payload.
- Produces: no exported API beyond the existing `fetchChemicalCostByTarget`.

- [ ] **Step 1: Update the payload types**

In `finance-api.ts`:

```ts
export interface CostCell {
  value: number;
  attributed: number;
  split: number;
  split_items: string[];
}

export interface UntargetedItem {
  item_code: string;
  item_name: string;
  kind: "chemical" | "foliar";
  value: number;
}

export interface UnattributedEntry {
  cost_center: string;
  kind: "chemical" | "foliar";
  value: number;
}
```

Change `costs` on the row type from `Record<string, number>` to `Record<string, CostCell>`, and add `kind`, `totals_by_kind`, `unattributed`, `untargeted_items` to `ChemicalCostReport`.

- [ ] **Step 2: Render split cells distinctly**

A cell with `split > 0` is not a measured number and must not read like one. Render the value, then a marker carrying the split proportion, with the contributing item codes in a tooltip:

```tsx
const isSplit = cell.split > 0;
const splitPct = cell.value ? Math.round((cell.split / cell.value) * 100) : 0;

<td className={isSplit ? "text-amber-700 dark:text-amber-500" : undefined}>
  {fmt(cell.value)}
  {isSplit && (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="ml-1 text-[10px] font-medium">~{splitPct}%</span>
      </TooltipTrigger>
      <TooltipContent>
        {splitPct}% of this figure is split evenly across the plan's targets
        because these products have no targets recorded:
        <br />{cell.split_items.join(", ")}
      </TooltipContent>
    </Tooltip>
  )}
</td>
```

Colour and a `~` marker only — **no left-border bar or accent strip** (house rule).

- [ ] **Step 3: Add the untargeted-chemicals panel**

Below the table, render `untargeted_items` sorted by value descending, headed *"Chemicals with no targets recorded"* with a one-line explanation that their cost is split evenly across each plan's targets until an agronomist fills them in. This list is the actionable backlog and should shrink over time.

- [ ] **Step 4: Add the unattributed section**

Render `unattributed` grouped by cost centre with the note: *"Issued directly from the store without a work order, so it carries no greenhouse or target."* Show `totals_by_kind` so foliar spend is legible next to chemical spend.

- [ ] **Step 5: Update the header copy**

The subtitle currently reads *"Chemical spend by greenhouse & target · actual chemicals moved"*. It is now chemicals **and foliars**, across two stock-entry purposes. Replace with: *"Chemical & foliar spend by greenhouse and target · all product consumed"*, and add a short note that totals now include direct store issues, which were previously excluded.

- [ ] **Step 6: Build and check**

```bash
cd /home/ubuntu/stive/code/frappe16/apps/upande_scp/frontend && yarn build
```

Expected: clean build, no TypeScript errors. Load the Finance page and confirm split cells are marked, the untargeted panel lists items, and the unattributed section shows the store-issued foliar spend.

- [ ] **Step 7: Stage**

```bash
git add frontend/src/lib/finance-api.ts frontend/src/pages/Finance.tsx
```

---

### Task 9: Retire `chemical_meta.py`

**Files:**
- Delete: `upande_scp/serverscripts/chemical_meta.py`
- Modify: `upande_scp/serverscripts/spray_plan_creator/validation.py:191-192`

**Interfaces:**
- Consumes: `crop_protection.effective_rate_limits` (confirm the exact name in the ported module before writing the call).
- Produces: nothing new.

**Context:** `finances.py` stopped importing it in Task 7. `validation.py` is the last live caller; `patches/v1_0/prefill_chemical_metadata.py` only names it in a log string and needs no change.

- [ ] **Step 1: Confirm the replacement's exact signature**

```bash
grep -n 'def .*rate_limit' /home/ubuntu/stive/code/frappe16/apps/upande_scp/upande_scp/serverscripts/common/crop_protection.py
```

Use whatever name that prints. Do not guess.

- [ ] **Step 2: Write the failing test**

```python
import unittest


class TestChemicalMetaRetired(unittest.TestCase):
    def test_module_is_gone(self):
        with self.assertRaises(ImportError):
            from upande_scp.serverscripts import chemical_meta  # noqa: F401

    def test_no_live_imports_remain(self):
        import pathlib
        root = pathlib.Path(__file__).resolve().parents[2]
        hits = [
            str(p) for p in root.rglob("*.py")
            if "__pycache__" not in str(p) and "chemical_meta" in p.read_text()
            and "prefill_chemical_metadata" not in p.name
        ]
        self.assertEqual(hits, [], f"chemical_meta still referenced in: {hits}")
```

- [ ] **Step 3: Run and watch it fail**

Run: `bench --site mona.local run-tests --app upande_scp --module upande_scp.serverscripts.tests.test_chemical_meta_retired`
Expected: FAIL — the module still imports and `validation.py` still references it.

- [ ] **Step 4: Repoint `validation.py` and delete the module**

Replace lines 191-192 with the `crop_protection` equivalent found in Step 1, then:

```bash
git rm upande_scp/serverscripts/chemical_meta.py
```

- [ ] **Step 5: Run the full server-side suite**

```bash
cd /home/ubuntu/stive/code/frappe16
bench --site mona.local run-tests --app upande_scp
```

Expected: PASS. Rate-limit validation is the regression risk here — `chemical_meta.rate_limits` fell back to Item `custom_*` fields, which `crop_protection` does not. Any test that relied on that fallback is telling you about real data that has not been migrated; investigate rather than skip.

- [ ] **Step 6: Stage**

```bash
git add upande_scp/serverscripts/spray_plan_creator/validation.py \
        upande_scp/serverscripts/tests/test_chemical_meta_retired.py
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §4.1 foundation port | 1, 2 |
| §4.2 picker fix | 4 |
| §4.3 seeding, provenance, actives, aliases | 5, 6 |
| §4.4 FRAC/IRAC normalisation | 5 (`normalise_codes`), 6 (frac/irac routing) |
| §4.5 finance rewrite | 7 |
| §4.6 UI: split highlighting, untargeted panel, unattributed | 8 |
| §5 migration order | 1 → 2 → 3 → 6 (patches registered in that order) |
| §6 gotchas | 1 (collation), 6 (`parenttype` filter) |
| §7 testing incl. reconciliation invariant | 7 step 1 |

Not covered by any task, deliberately, per spec §3: per-greenhouse foliar breakdown, broader UI parity, history backfill, the settings rename.

**Placeholder scan:** no TBD/TODO. Every code step carries real code. Task 9 Step 1 asks the implementer to read a signature rather than guess it — that is a deliberate instruction, not a placeholder.

**Type consistency:** `CostCell` fields (`value`, `attributed`, `split`, `split_items`) are identical in Task 7's interface block, Task 7's tests, and Task 8's TypeScript. `product_groups`, `classify_item_group`, `is_foliar_group` are named identically in Tasks 2, 4, 6, 7. `seed_from_book`'s report keys match between Task 6's interface block, its tests and its implementation.

---

## Execution record — 2026-08-25

All 9 tasks implemented on `feat/foliar-aware-finance`. Deviations from the plan
as written, and why:

**Added, not planned — Chemical schema convergence.** The plan assumed mona's
`Chemical` already matched kaitet's. It did not: mona had `targets`,
`lower_rate_limit`, `upper_rate_limit` where `crop_protection` reads
`default_targets`, `default_lower_rate_limit`, `default_upper_rate_limit`. Added
`patches/v1_0/converge_chemical_to_kaitet_schema.py` (19 target rows repointed),
kept `allowed` / `application_rate` / `description` / `crop_scouted` (live readers
or data), dropped `pack_rate` (empty, no reader), and repointed `settings.py`,
`backfill_chemical_master`, `prefill_chemical_metadata`. Also made
`Chemical.validate()` config-driven — the hardcoded item-group literal's **third**
site, which silently blocked chemical registration on any differently-spelled group.

**Task 2 — kaitet's `test_crop_protection.py` was NOT ported wholesale.** It depends
on the settings editor, the packaged `serverscripts/{store,scouting}` layout, the
group-overlap validator and `Crop Scouted`, and asserts Item's chemical `custom_*`
fields are gone — none true on mona. A mona-focused equivalent was written instead.

**Task 3 — delegates to `crop_protection.ensure_product_record`** rather than
hand-rolling the insert, and the `after_insert` hook was registered in `hooks.py` so
new items get a sidecar without waiting for a backfill.

**Task 5 — the plan's junk-code list was wrong.** It listed `11` for dropping.
FRAC 11 (QoI / strobilurins) is a real group appearing 11 times in this book; only
the three-digit `111` is the mangled Roman numeral. Corrected before running, and
`test_frac_11_survives_but_mangled_111_does_not` guards it.

**Task 6 — the Nematodes test asserted the wrong behaviour.** None of the book's
five nematicides is in mona's catalogue, so nothing targets Nematodes and the Pest
master must NOT be created. Test inverted to assert that.

**Task 7 — a bug the planned tests did not catch.** `_attribute` checked the foliar
branch before "no plan targets", so store-issued foliar was given a `Nutrition`
bucket under a phantom greenhouse. Found by reading the report output, not by a red
test. Fixed, and guarded by `test_store_issued_foliar_is_unattributed_not_nutrition`
and `test_no_row_is_attributed_to_a_missing_greenhouse`.

**Task 8 Step 6 — verified by component test, not by a browser.** No browser is
installed on this machine and installing one is a persistent environment change.
Instead the page is covered by `frontend/src/pages/__tests__/Finance.test.tsx`
(6 tests, vitest + jsdom), which is repeatable and guards against regression. The
endpoint was additionally verified end-to-end over HTTP against a live
`bench serve` with a real Administrator session.

### Known shortfalls (not blocking, worth closing later)

- The loader's report counts `skipped_existing` but does not name which values it
  declined to write; spec §4.3 asks for "every value it declined to write".
- `test_ppp_parse` asserts 3 of the 9 ambiguous actives (azoxystrobin, pyrethrins,
  buprofezin), not all 9.
- 5 `test_dashboard_aggregates_*` modules fail on this site in ERPNext's test
  bootstrap (Fiscal Year 2025-2026 overlap). Verified pre-existing by stashing all
  changes and reproducing. `test_dashboard_aggregates_fixture` has no tests at all —
  it is a shared helper.
