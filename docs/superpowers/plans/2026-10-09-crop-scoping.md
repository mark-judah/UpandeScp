# Crop Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every screen in a crop's section (`#/rose/…`, `#/avocado/…`, `#/coffee/…`) shows only that crop's farms, greenhouses/blocks, pests and diseases, and the filtering happens on the server.

**Architecture:** One new lookup module, `common/crop_catalog.py`, owns "what belongs to a crop" (pests, diseases, farms, greenhouses, crop of a greenhouse) plus the two SQL fragments every aggregate uses: the D5 entry condition (crop-less entries count under their greenhouse's crop) and the D4 child-row condition (off-crop pests/diseases excluded). Dashboard aggregates, the observations payload, the spray-plan bootstrap/diagnose/validation and the thresholds API all read it; the React pages stop carrying crop pickers and pass the route crop to the server.

**Tech Stack:** Frappe v16 / Python 3.14, MariaDB, Redis cache; React + TypeScript + Vite + vitest (jsdom, @testing-library/react) in `frontend/`.

**Spec:** `docs/superpowers/specs/2026-10-09-crop-scoping-design.md`

## Global Constraints

- Site is **`kaitet.local`** only; query it read-only with `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local mariadb -e "SELECT …"`. **Never use the Kaitet MCP** (`mcp__claude_ai_Kaitet*`), for anything.
- Commits: **no `Co-Authored-By` trailer** (CLAUDE.md). Style: `feat(scp): …` / `fix(scp): …` / `feat(scp-ui): …`, lowercase sentence.
- Start from a clean tree: branch `kaitet` currently carries someone else's uncommitted work in files this plan edits (`spray_plan_creator/bootstrap.py`, `scouting/scouting_metrics_api.py`, `spray_compliance/context.py`, …). Ask the user to commit or stash it before Task 1; never stage hunks you did not write (use `git add -p` if a file is mixed).
- Indentation: match each file. `spray_compliance/context.py` uses **tabs**; every other file touched here (and every new file in this plan) uses **4 spaces**.
- **Server-side filtering only**: nothing outside the route crop is fetched and then hidden in the browser. The one documented exception is the IndexedDB delta sync (`get_entries_since`, one global watermark), which is out of scope.
- UI: **no vertical accent strips / coloured left-border bars** on cards or rows; accent via icon/text colour or a pill.
- Back-compat: when `crop` is omitted or `""`, every endpoint behaves exactly as today (`fetch_creator_bootstrap()`, aggregates with `crop=""`, `get_farms_and_warehouses()`, `getScoutingEntriesChunk` without crop). A greenhouse whose farm is on no crop gets today's (unfiltered) behaviour in diagnose and target validation.
- Crop names: canonical names are the `Crop Scouted` names, verbatim `Rose`, `Avocado`, `Coffee`. Routes carry slugs (`rose`); `cropDisplayName("rose") === "Rose"` (`frontend/src/lib/router.ts:81`). The server matches crop names case-insensitively through `crop_catalog.canonical` and always works with the canonical name after that.
- Unknown or not-allowed crop → `frappe.PermissionError` (via `crop_catalog.resolve_crop` → `crop_scope.assert_crop`), never "show everything". A crop with no linked pests/diseases → empty lists, never the full catalog.
- Reuse `common/crop_scope.py` (`farms_for_crop` :231, `scoped_farms` :246, `scoped_greenhouses` :261, `allowed_crops` :146, `assert_crop` :176). Do not write a second farm-scoping rule.
- Test commands:
  - Pure: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q <path>`
  - DB (direct runner; each test rolls back in `tearDown`): `cd /home/ubuntu/stive/code/frappe15/sites && ../env/bin/python -c "import frappe, unittest; frappe.init(site='kaitet.local'); frappe.connect(); frappe.set_user('Administrator'); import importlib; M=importlib.import_module('upande_scp.serverscripts.tests.<module>'); r=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(M)); raise SystemExit(not r.wasSuccessful())"` — written below as **DB-RUN `<module>`**.
  - Frontend: `cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run <path>`; typecheck `npx tsc --noEmit -p tsconfig.app.json` (plain `-p .` checks nothing: `tsconfig.json` only has references); build `yarn build`.
- DB tests insert Scouting Entries with **raw SQL** dated in 2031 (no real data there; live max is 2026-09). Raw inserts skip the controller and the cache-busting doc events, so: every aggregate call in a test passes `force="1"` unless the test is about the cache, and Observations tests delete their week keys in `setUp`/`tearDown`.
- Pre-existing, unrelated: `test_dashboard_aggregates_{overview,pests_diseases,gh_detail,traps,fcm}` already error on kaitet.local (`MandatoryError: [Warehouse, Karen Farm - KR]: custom_farm` in their fixture). Do not "fix" them here; they are not a regression signal.
- After Python changes, manual checks need `sudo -n supervisorctl restart frappe15-web:` (workers preload code).

## Review Focus

The five most likely un-tested failure modes, each with the test that pins it:

1. **Slug vs name casing** (`rose` from the route vs `Rose` in `Crop Scouted`; MariaDB compares them equal, Python sets do not). → Task 1 `test_canonical_is_case_insensitive`, `test_lookups_accept_route_slugs`; Task 2 `test_a_lowercase_route_crop_shares_the_canonical_cache_entry`; Task 6 `test_get_thresholds_canonicalises_the_crop`.
2. **Users with restricted crop scope** (Peter Kamuren, Karen Roses, sees Rose only) asking for another crop. → Task 1 `test_a_rose_only_user_cannot_resolve_avocado`; Task 2 `test_a_rose_only_user_is_refused_avocado_aggregates`; Task 5 `test_a_rose_only_user_cannot_bootstrap_avocado`.
3. **Cache keys leaking one crop's payload to another** (aggregates via `cached_aggregate`, the crop index and the observations week slices are all site-wide Redis keys). → Task 1 `test_the_index_is_not_built_through_permissions` (a restricted user warming the index must not shrink it for everyone); Task 2 `test_one_crops_payload_is_not_served_to_another`; Task 4 `test_crop_slices_are_cached_per_crop`.
4. **Empty crop list returning the full catalog** (`IN ()` is a syntax error, and dropping the clause would widen). → Task 1 `test_a_crop_with_nothing_linked_matches_nothing` (sentinel `NO_MATCH`); Task 5 `test_a_crop_with_no_pests_offers_none`.
5. **Crop-less entries double counted** (once via `crop_scouted`, once via greenhouse; or under two crops whose farms overlap). → Task 1 `test_a_greenhouse_counts_under_one_crop_only`; Task 2 `test_a_crop_less_entry_counts_once_under_its_greenhouse_crop`; Task 4 `test_rose_slice_has_crop_less_rows_once`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `upande_scp/serverscripts/common/crop_catalog.py` (new) | Crop index (pests, diseases, farms, greenhouses, farm→crop) cached in Redis; `resolve_crop`, `canonical`, lookups, D5/D4 SQL fragments and params |
| `upande_scp/serverscripts/common/cache_utils.py` (mod) | `K_CROP_CATALOG` + invalidation; crop-less scouting writes bust their greenhouse crop's week slice; Rose slices busted too |
| `upande_scp/serverscripts/spray_compliance/context.py` (mod, tabs) | `crop_for_greenhouse` delegates to `crop_catalog` |
| `upande_scp/serverscripts/dashboard_aggregates/_common.py` (mod) | `parent_filter_conditions` uses D5; new `obs_filter` (D4); cache-key schema tag |
| `upande_scp/serverscripts/dashboard_aggregates/__init__.py` (mod) | `_call` resolves/asserts the crop once for every aggregate |
| `upande_scp/serverscripts/dashboard_aggregates/_overview.py`, `_trends.py`, `_pests_diseases.py`, `_gh_detail.py`, `_heatmaps.py` (mod) | D4 child-row filter; heatmaps' two side queries use D5 |
| `upande_scp/serverscripts/dashboard_aggregates/_application_plan.py` (mod) | Diagnose crop from the greenhouse; D5 + D4 |
| `upande_scp/serverscripts/scouting/get_complete_scouting_entries.py` (mod) | Crop slice = D5 entries + D4 children; dense slices not cached past the window; crop resolved |
| `upande_scp/serverscripts/scouting/scouting_metrics_api.py` (mod) | `get_farms_and_warehouses` resolves the crop |
| `upande_scp/serverscripts/spray_plan_creator/bootstrap.py` (mod) | `fetch_creator_bootstrap(crop=None)` |
| `upande_scp/serverscripts/spray_plan_creator/validation.py` (mod) | `validate_targets_in_scope(..., crop=None)` |
| `upande_scp/serverscripts/spray_plan_creator/drafts.py` (mod) | passes the greenhouse's crop to validation |
| `upande_scp/serverscripts/store/thresholds_api.py` (mod) | crop resolved; `save_thresholds` rejects rows of another crop |
| `upande_scp/serverscripts/tests/crop_scoping_fixture.py` (new) | raw-SQL Scouting Entry fixture + roster helper |
| `upande_scp/serverscripts/tests/test_crop_catalog_pure.py`, `test_crop_catalog.py`, `test_crop_scoped_aggregates.py`, `test_crop_scoped_aggregate_detail.py`, `test_crop_scoped_observations.py`, `test_crop_scoped_spray_plan.py`, `test_thresholds_crop_guard.py` (new) | tests |
| `upande_scp/serverscripts/tests/test_cache_invalidation.py` (mod) | invalidation tests |
| `frontend/src/hooks/use-crop-farms.ts` (new) | route crop → server-narrowed farm/warehouse map |
| `frontend/src/hooks/use-scouting.ts` (mod) | Rose is a scoped crop too |
| `frontend/src/pages/maps/MapHeader.tsx`, `RangeHeader.tsx`, `SingleDayHeader.tsx` (mod) | crop picker and `showCrop` removed; farms from the server for `value.crop` |
| `frontend/src/pages/{TrapsMap,RoseScouting,Observations,Spraying}.tsx`, `pages/avocado/AvocadoTreeMap.tsx` (mod) | drop `showCrop={false}`; TrapsMap farms by crop |
| `frontend/src/pages/Heatmaps.tsx`, `Dashboard.tsx`, `Trends.tsx` (mod) | crop picker removed; route crop always sent (Rose no longer `""`) |
| `frontend/src/lib/spray-plan-creator-api.ts` (mod) | `fetchCreatorBootstrap(crop?)` |
| `frontend/src/pages/ApplicationPlan.tsx`, `pages/avocado/BlockSprayPlan.tsx`, `pages/avocado/AvocadoHeatMap.tsx`, `App.tsx` (mod) | route crop to bootstrap; no hard-coded `"Rose"` |
| `frontend/src/components/settings/ThresholdsTab.tsx`, `pages/Settings.tsx` (mod) | thresholds follow the route crop; picker removed |
| frontend tests (new): `hooks/__tests__/use-crop-farms.test.ts`, `hooks/__tests__/use-scouting-crop.test.ts`, `pages/maps/__tests__/MapHeader.crop.test.tsx`, `pages/__tests__/Dashboard.crop.test.tsx`, `pages/__tests__/Trends.crop.test.tsx`, `lib/spray-plan-creator-api.test.ts`, `pages/avocado/__tests__/BlockSprayPlan.crop.test.tsx`, `pages/__tests__/ApplicationPlan.crop.test.ts`, `components/settings/__tests__/ThresholdsTab.test.tsx` | tests |

---

### Task 1: `crop_catalog` — the crop index, SQL fragments and crop resolution

**Files:**
- Create: `upande_scp/serverscripts/common/crop_catalog.py`
- Modify: `upande_scp/serverscripts/common/cache_utils.py` (key block ~33-79; `_DOC_INVALIDATIONS` ~575-605)
- Modify: `upande_scp/serverscripts/spray_compliance/context.py:20-26` (tabs)
- Create: `upande_scp/serverscripts/tests/test_crop_catalog_pure.py`, `upande_scp/serverscripts/tests/test_crop_catalog.py`
- Modify: `upande_scp/serverscripts/tests/test_cache_invalidation.py` (append a class)

**Interfaces:**
- Consumes: `crop_scope.assert_crop(crop, user)`; `cache_utils.get_or_set(key, builder, ttl)`, `cache_utils.invalidate(*keys)`, `cache_utils.TTL_MEDIUM`.
- Produces (all in `upande_scp.serverscripts.common.crop_catalog`):
  - `NO_MATCH: str = "__scp_no_match__"`
  - `build_index(crop_names, pest_rows, disease_rows, farm_rows, house_rows) -> dict` (pure; keys `crops`, `pests`, `diseases`, `farms`, `farm_crop`, `houses`)
  - `catalog() -> dict`, `invalidate_catalog() -> None`
  - `canonical(crop: str | None) -> str` (`""` for blank/unknown)
  - `resolve_crop(crop: str | None, user: str | None = None) -> str` (`""` for blank; throws `frappe.PermissionError` for unknown or not-allowed)
  - `pests_for_crop(crop) -> list[str]`, `diseases_for_crop(crop) -> list[str]`, `targets_for_crop(crop) -> list[str]`, `greenhouses_for_crop(crop) -> list[str]`
  - `crop_for_farm(farm) -> str | None`, `crop_for_greenhouse(wh) -> str | None`
  - `entry_crop_condition(alias: str = "se") -> str`, `obs_crop_condition(kind: str, column: str) -> str`, `crop_sql_params(crop) -> dict` (keys `crop`, `crop_whs`, `crop_pests`, `crop_diseases`, tuples padded with `NO_MATCH`)
  - `cache_utils.K_CROP_CATALOG = "scp:crop_catalog_v1"`

- [ ] **Step 1: Write the failing pure test** — `upande_scp/serverscripts/tests/test_crop_catalog_pure.py`

```python
"""crop_catalog's pure parts — runs under plain pytest, no site."""

from unittest.mock import patch

import pytest

from upande_scp.serverscripts.common import crop_catalog as CC

IDX = CC.build_index(
    ["Rose", "Avocado", "Coffee"],
    [
        {"crop_scouted": "Rose", "pest": "Thrips"},
        {"crop_scouted": "Avocado", "pest": "Fruit fly (Ceratitis)"},
        {"crop_scouted": "Rose", "pest": ""},
    ],
    [{"crop_scouted": "Avocado", "disease": "Avocado Scab"}],
    # Ordered by (idx, parent) as _load() orders them: Rose lists Chepsito first.
    [
        {"parent": "Rose", "farm": "Chepsito"},
        {"parent": "Avocado", "farm": "Lokitela"},
        {"parent": "Coffee", "farm": "Chepsito"},
    ],
    [
        {"name": "Chepsito GH 01 - KR", "custom_farm": "Chepsito"},
        {"name": "AIRSTRIP BLK 1 - KL", "custom_farm": "Lokitela"},
        {"name": "Orphan", "custom_farm": "Nowhere"},
    ],
)


def test_index_lists_are_sorted_and_blank_rows_dropped():
    assert IDX["pests"] == {"Rose": ["Thrips"], "Avocado": ["Fruit fly (Ceratitis)"]}
    assert IDX["diseases"] == {"Avocado": ["Avocado Scab"]}
    assert IDX["crops"] == ["Avocado", "Coffee", "Rose"]


def test_a_farm_belongs_to_the_first_crop_that_lists_it():
    assert IDX["farm_crop"]["Chepsito"] == "Rose"
    # Membership is still recorded for every crop that lists the farm.
    assert IDX["farms"]["Coffee"] == ["Chepsito"]


def test_a_greenhouse_counts_under_one_crop_only():
    """D5 must be single-valued, or a crop-less entry counts under two crops."""
    assert IDX["houses"]["Rose"] == ["Chepsito GH 01 - KR"]
    assert "Coffee" not in IDX["houses"]
    assert IDX["houses"]["Avocado"] == ["AIRSTRIP BLK 1 - KL"]


def test_entry_crop_condition_shape():
    assert CC.entry_crop_condition("se") == (
        "(se.crop_scouted = %(crop)s OR (IFNULL(se.crop_scouted, '') = '' "
        "AND se.greenhouse IN %(crop_whs)s))"
    )


def test_obs_crop_condition():
    assert CC.obs_crop_condition("pest", "p.pest") == "p.pest IN %(crop_pests)s"
    assert CC.obs_crop_condition("disease", "d.disease") == "d.disease IN %(crop_diseases)s"
    with pytest.raises(KeyError):
        CC.obs_crop_condition("trap", "t.pest")


def test_canonical_is_case_insensitive():
    with patch.object(CC, "catalog", return_value=IDX):
        assert CC.canonical("rose") == "Rose"
        assert CC.canonical(" ROSE ") == "Rose"
        assert CC.canonical("Mango") == ""
        assert CC.canonical("") == ""
        assert CC.canonical(None) == ""


def test_lookups_accept_route_slugs():
    with patch.object(CC, "catalog", return_value=IDX):
        assert CC.pests_for_crop("rose") == ["Thrips"]
        assert CC.targets_for_crop("avocado") == ["Avocado Scab", "Fruit fly (Ceratitis)"]
        assert CC.greenhouses_for_crop("rose") == ["Chepsito GH 01 - KR"]
        assert CC.crop_for_farm("Chepsito") == "Rose"
        assert CC.crop_for_farm("Nowhere") is None
        assert CC.crop_for_farm("") is None


def test_a_crop_with_nothing_linked_matches_nothing():
    with patch.object(CC, "catalog", return_value=IDX):
        p = CC.crop_sql_params("rose")
        assert p["crop"] == "Rose"
        assert p["crop_pests"] == ("Thrips",)
        assert p["crop_diseases"] == (CC.NO_MATCH,)
        p = CC.crop_sql_params("Mango")
        assert p["crop"] == CC.NO_MATCH
        assert p["crop_whs"] == (CC.NO_MATCH,)
        assert p["crop_pests"] == (CC.NO_MATCH,)
        assert p["crop_diseases"] == (CC.NO_MATCH,)
```

- [ ] **Step 2: Write the failing DB test** — `upande_scp/serverscripts/tests/test_crop_catalog.py`

```python
"""crop_catalog against kaitet.local. DB test — direct runner, rolled back."""

import unittest

import frappe

from upande_scp.serverscripts.common import crop_catalog as CC
from upande_scp.serverscripts.common import crop_scope

PETER = "pkamuren@karenroses.com"  # SCP General Manager at Karen Roses: Rose only


def _rose_greenhouse():
    farms = [r[0] for r in frappe.db.sql(
        "select farm from `tabFarm Filter` where parenttype='Crop Scouted' and parent='Rose'")]
    return frappe.db.sql(
        """select name from `tabWarehouse` where custom_farm in %(f)s and is_group=0
           and warehouse_type='Greenhouse' and disabled=0 order by name limit 1""",
        {"f": tuple(farms)})[0][0]


def _avocado_block():
    return frappe.db.sql(
        """select name from `tabWarehouse` where custom_farm='Lokitela' and is_group=0
           and warehouse_type='Block' and disabled=0 order by name limit 1""")[0][0]


class TestCropCatalog(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        CC.invalidate_catalog()

    def tearDown(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        CC.invalidate_catalog()
        frappe.db.rollback()

    def test_lists_come_from_the_filter_rows(self):
        rose = frappe.db.sql("select count(distinct pest) from `tabPest Filter` where crop_scouted='Rose'")[0][0]
        self.assertEqual(len(CC.pests_for_crop("Rose")), rose)
        self.assertIn("Thrips", CC.pests_for_crop("Rose"))
        self.assertIn("Avocado Scab", CC.diseases_for_crop("Avocado"))
        self.assertNotIn("Avocado Scab", CC.diseases_for_crop("Rose"))
        self.assertEqual(
            CC.targets_for_crop("Rose"),
            sorted(set(CC.pests_for_crop("Rose")) | set(CC.diseases_for_crop("Rose"))),
        )

    def test_crop_of_a_greenhouse_and_a_block(self):
        self.assertEqual(CC.crop_for_greenhouse(_rose_greenhouse()), "Rose")
        self.assertEqual(CC.crop_for_greenhouse(_avocado_block()), "Avocado")
        self.assertIsNone(CC.crop_for_greenhouse("Nowhere"))
        self.assertIsNone(CC.crop_for_greenhouse(""))

    def test_greenhouses_follow_the_farms(self):
        gh = _rose_greenhouse()
        self.assertIn(gh, CC.greenhouses_for_crop("Rose"))
        self.assertNotIn(gh, CC.greenhouses_for_crop("Avocado"))
        self.assertIn(_avocado_block(), CC.greenhouses_for_crop("Avocado"))

    def test_resolve_crop_canonicalises(self):
        self.assertEqual(CC.resolve_crop("rose"), "Rose")
        self.assertEqual(CC.resolve_crop(""), "")
        self.assertEqual(CC.resolve_crop(None), "")

    def test_an_unknown_crop_is_refused(self):
        with self.assertRaises(frappe.PermissionError):
            CC.resolve_crop("Mango")

    def test_a_rose_only_user_cannot_resolve_avocado(self):
        if not frappe.db.exists("Employee", {"user_id": PETER}):
            self.skipTest("Peter Kamuren has no Employee record on this site")
        self.assertEqual(CC.resolve_crop("Rose", PETER), "Rose")
        with self.assertRaises(frappe.PermissionError):
            CC.resolve_crop("Avocado", PETER)

    def test_the_index_is_not_built_through_permissions(self):
        """A restricted user warming the cache must not shrink it for everyone."""
        if not frappe.db.exists("Employee", {"user_id": PETER}):
            self.skipTest("Peter Kamuren has no Employee record on this site")
        frappe.set_user(PETER)
        CC.invalidate_catalog()
        CC.catalog()
        frappe.set_user("Administrator")
        self.assertEqual(set(CC.catalog()["crops"]), {"Rose", "Avocado", "Coffee"})
        self.assertTrue(CC.pests_for_crop("Avocado"))
```

- [ ] **Step 3: Append the invalidation test** to `upande_scp/serverscripts/tests/test_cache_invalidation.py`

```python
class TestCropCatalogInvalidation(unittest.TestCase):
    def test_every_source_of_the_index_busts_it(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        for dt in ("Crop Scouted", "Pest Filter", "Disease Filter", "Warehouse", "Farm"):
            self.assertIn(cu.K_CROP_CATALOG, cu._DOC_INVALIDATIONS[dt], dt)
```

- [ ] **Step 4: Run them and watch them fail**

`cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_crop_catalog_pure.py upande_scp/serverscripts/tests/test_cache_invalidation.py`
Expected: collection error `ImportError: cannot import name 'crop_catalog'` and `AttributeError: module ... has no attribute 'K_CROP_CATALOG'`.

DB-RUN `test_crop_catalog` → `ImportError: cannot import name 'crop_catalog'`.

- [ ] **Step 5: Add the cache key** — `upande_scp/serverscripts/common/cache_utils.py`

After the line `K_CROPS_SCOUTED = "scp:crops_scouted_v1"` add:

```python
# What belongs to each crop — pests, diseases, farms, greenhouses, farm→crop.
# One site-wide entry (see common/crop_catalog.py); built with raw SQL so no
# user's permission scope is ever stored in it.
K_CROP_CATALOG = "scp:crop_catalog_v1"
```

In `_DOC_INVALIDATIONS`, append `K_CROP_CATALOG` to these five tuples (leave the others untouched):

```python
    "Warehouse": (K_GREENHOUSES_GEOJSON, K_BLOCKS_GEOJSON, K_FARMS_AND_GREENHOUSES, K_AFP_WAREHOUSES, K_SM_FARMS_AND_GHS, K_SM_FARMS_AND_WHS, K_SM_UNITS_BY_WH, K_FARM_HIERARCHY, K_ZONE_CENTROIDS, K_CROP_CATALOG),
    "Farm": (K_FARMS_AND_GREENHOUSES, K_SM_FARMS_AND_GHS, K_SM_FARMS_AND_WHS, K_FARM_HIERARCHY, K_CROP_CATALOG),
    ...
    "Crop Scouted": (K_CROPS_SCOUTED, K_SM_SEVERITY_THRESHOLDS, K_CROP_CATALOG),
    "Pest Filter": (K_OBSERVATION_TYPES, K_SM_SEVERITY_THRESHOLDS, K_CROP_CATALOG),
    "Disease Filter": (K_OBSERVATION_TYPES, K_SM_SEVERITY_THRESHOLDS, K_CROP_CATALOG),
```

(`Farm Filter` is a child of `Crop Scouted`, so saving the crop busts it; all five doctypes are already wired to `invalidate_on_change` in `hooks.py:236-313`.)

- [ ] **Step 6: Create `upande_scp/serverscripts/common/crop_catalog.py`**

```python
"""What belongs to a crop: its pests, diseases, farms and greenhouses.

The crop is fixed by the route (`#/rose/…`). Every crop-scoped list on the server
reads it from here, from the same rows the mobile app's `getObservationsDetails`
reads (`Pest Filter` / `Disease Filter` by `crop_scouted`), so web and phone agree.

**One site-wide Redis entry, built with raw SQL.** `Crop Scouted` carries a
permission query condition; an index built through `frappe.get_all` would store
the first caller's crops and serve them to everyone.

**Crop names are matched case-insensitively.** Routes carry `rose`, the doctype is
`Rose`. MariaDB would compare them equal; a Python set would not. Everything
below goes through `canonical()` first.

**A greenhouse belongs to exactly one crop** — the first crop (by `Farm Filter.idx`)
that lists its farm, the rule `spray_compliance.context.crop_for_greenhouse` always
used. That is what keeps D5 ("a crop-less entry counts under its greenhouse's
crop") from counting one entry under two crops.
"""

from __future__ import annotations

import frappe

from upande_scp.serverscripts.common import crop_scope
from upande_scp.serverscripts.common.cache_utils import (
    K_CROP_CATALOG,
    TTL_MEDIUM,
    get_or_set,
    invalidate,
)

#: Pads an empty `IN (...)` list. MariaDB rejects `IN ()`, and dropping the clause
#: instead would widen the result to every crop — the opposite of an empty list.
NO_MATCH = "__scp_no_match__"

_OBS_PARAM = {"pest": "crop_pests", "disease": "crop_diseases"}


def build_index(crop_names, pest_rows, disease_rows, farm_rows, house_rows) -> dict:
    """Fold the raw rows into the lookup index. Pure.

    ``farm_rows`` must arrive ordered by (idx, parent): the first crop to list a
    farm owns it.
    """
    pests: dict[str, set] = {}
    for r in pest_rows:
        if r.get("crop_scouted") and r.get("pest"):
            pests.setdefault(r["crop_scouted"], set()).add(r["pest"])

    diseases: dict[str, set] = {}
    for r in disease_rows:
        if r.get("crop_scouted") and r.get("disease"):
            diseases.setdefault(r["crop_scouted"], set()).add(r["disease"])

    farms: dict[str, set] = {}
    farm_crop: dict[str, str] = {}
    for r in farm_rows:
        crop, farm = r.get("parent"), r.get("farm")
        if not crop or not farm:
            continue
        farms.setdefault(crop, set()).add(farm)
        farm_crop.setdefault(farm, crop)

    houses: dict[str, set] = {}
    for r in house_rows:
        owner = farm_crop.get(r.get("custom_farm") or "")
        if owner and r.get("name"):
            houses.setdefault(owner, set()).add(r["name"])

    def _lists(d: dict) -> dict:
        return {k: sorted(v) for k, v in d.items()}

    return {
        "crops": sorted(c for c in crop_names if c),
        "pests": _lists(pests),
        "diseases": _lists(diseases),
        "farms": _lists(farms),
        "farm_crop": farm_crop,
        "houses": _lists(houses),
    }


def _load() -> dict:
    sql = frappe.db.sql
    return build_index(
        [r[0] for r in sql("select name from `tabCrop Scouted`")],
        sql(
            """select crop_scouted, pest from `tabPest Filter`
               where ifnull(crop_scouted, '') != '' and ifnull(pest, '') != ''""",
            as_dict=True,
        ),
        sql(
            """select crop_scouted, disease from `tabDisease Filter`
               where ifnull(crop_scouted, '') != '' and ifnull(disease, '') != ''""",
            as_dict=True,
        ),
        sql(
            """select parent, farm from `tabFarm Filter`
               where parenttype = 'Crop Scouted' and parentfield = 'farms'
               order by idx, parent""",
            as_dict=True,
        ),
        sql(
            """select name, custom_farm from `tabWarehouse`
               where is_group = 0 and ifnull(custom_farm, '') != ''""",
            as_dict=True,
        ),
    )


def catalog() -> dict:
    return get_or_set(K_CROP_CATALOG, _load, ttl=TTL_MEDIUM) or {}


def invalidate_catalog() -> None:
    invalidate(K_CROP_CATALOG)


def canonical(crop) -> str:
    """`rose` → `Rose`. `""` for a blank or unknown crop."""
    name = (crop or "").strip()
    if not name:
        return ""
    low = name.lower()
    for c in catalog().get("crops", []):
        if c.lower() == low:
            return c
    return ""


def resolve_crop(crop, user: str | None = None) -> str:
    """The canonical crop for a request, refused when unknown or not allowed.

    Blank stays blank — that is the back-compat "no crop" path.
    """
    name = (crop or "").strip()
    if not name:
        return ""
    canon = canonical(name)
    if not canon:
        frappe.throw(f"Unknown crop: {name}.", frappe.PermissionError)
    crop_scope.assert_crop(canon, user)
    return canon


def pests_for_crop(crop) -> list[str]:
    return list(catalog().get("pests", {}).get(canonical(crop), []))


def diseases_for_crop(crop) -> list[str]:
    return list(catalog().get("diseases", {}).get(canonical(crop), []))


def targets_for_crop(crop) -> list[str]:
    return sorted(set(pests_for_crop(crop)) | set(diseases_for_crop(crop)))


def greenhouses_for_crop(crop) -> list[str]:
    return list(catalog().get("houses", {}).get(canonical(crop), []))


def crop_for_farm(farm) -> str | None:
    if not farm:
        return None
    return catalog().get("farm_crop", {}).get(farm) or None


def crop_for_greenhouse(wh) -> str | None:
    if not wh:
        return None
    farm = frappe.db.get_value("Warehouse", wh, "custom_farm")
    return crop_for_farm(farm)


def entry_crop_condition(alias: str = "se") -> str:
    """D5: the crop's entries plus crop-less entries in the crop's greenhouses.

    Params: `crop`, `crop_whs` — see `crop_sql_params`.
    """
    return (
        f"({alias}.crop_scouted = %(crop)s OR (IFNULL({alias}.crop_scouted, '') = '' "
        f"AND {alias}.greenhouse IN %(crop_whs)s))"
    )


def obs_crop_condition(kind: str, column: str) -> str:
    """D4: a pest/disease child row counts only when it is linked to the crop."""
    return f"{column} IN %({_OBS_PARAM[kind]})s"


def crop_sql_params(crop) -> dict:
    """Params for both conditions. Every list is padded with `NO_MATCH`, and an
    unknown crop becomes `NO_MATCH` too, so nothing ever widens to all crops."""
    canon = canonical(crop)
    return {
        "crop": canon or NO_MATCH,
        "crop_whs": tuple(greenhouses_for_crop(canon)) or (NO_MATCH,),
        "crop_pests": tuple(pests_for_crop(canon)) or (NO_MATCH,),
        "crop_diseases": tuple(diseases_for_crop(canon)) or (NO_MATCH,),
    }
```

- [ ] **Step 7: Delegate the spray-compliance copy** — `upande_scp/serverscripts/spray_compliance/context.py` (TABS)

Add after `from ..spray_plan_creator import crop_settings`:

```python
from ..common import crop_catalog
```

Replace lines 20-26 (the whole `def crop_for_greenhouse` body) with:

```python
def crop_for_greenhouse(greenhouse: str) -> str:
	"""The greenhouse's crop, or "" — kept as the "" -returning wrapper callers and
	`build_context` expect. The rule itself lives in `common.crop_catalog`."""
	return crop_catalog.crop_for_greenhouse(greenhouse) or ""
```

- [ ] **Step 8: Run all of it**

`cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_crop_catalog_pure.py upande_scp/serverscripts/tests/test_cache_invalidation.py` → `17 passed` (8 + 9).

DB-RUN `test_crop_catalog` → `Ran 7 tests … OK`.
DB-RUN `test_spray_compliance_context` → `Ran 8 tests … OK` (unchanged behaviour).
DB-RUN `test_crop_scope` → `Ran 32 tests … OK`.

- [ ] **Step 9: Commit**

```bash
git add upande_scp/serverscripts/common/crop_catalog.py upande_scp/serverscripts/common/cache_utils.py \
  upande_scp/serverscripts/spray_compliance/context.py \
  upande_scp/serverscripts/tests/test_crop_catalog_pure.py upande_scp/serverscripts/tests/test_crop_catalog.py \
  upande_scp/serverscripts/tests/test_cache_invalidation.py
git commit -m "feat(scp): one crop catalog says which pests, diseases, farms and greenhouses belong to a crop"
```

---

### Task 2: Aggregates core — D5 entry condition, D4 on Overview and Trends, crop resolved once

**Files:**
- Create: `upande_scp/serverscripts/tests/crop_scoping_fixture.py`, `upande_scp/serverscripts/tests/test_crop_scoped_aggregates.py`
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_common.py` (imports :7-11; `K_DASH_AGG_PREFIX` :258; `_build_key` :323-324; `parent_filter_conditions` :449-490)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/__init__.py` (`_call` :39-42)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_overview.py` (imports :6-11; `_observation_rows` :123-158; `_recent_activity` :344-360)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_trends.py` (imports :52-58; `_fetch_observations` :150-182)

**Interfaces:**
- Consumes: `crop_catalog.resolve_crop`, `crop_catalog.entry_crop_condition`, `crop_catalog.obs_crop_condition`, `crop_catalog.crop_sql_params`.
- Produces:
  - `_common.parent_filter_conditions(from_date, to_date, crop, greenhouse_scope, units=None) -> (str, dict)` — unchanged signature; with a crop, `where` contains `entry_crop_condition("se")` and `params` contains `crop`, `crop_whs`, `crop_pests`, `crop_diseases`.
  - `_common.obs_filter(kind: str, column: str, params: dict) -> str` — `""` when `params` has no `crop_pests`, else `" AND <column> IN %(crop_pests|crop_diseases)s"`.
  - `_common.K_DASH_AGG_SCHEMA = "crop2"` (in every aggregate cache key).
  - `dashboard_aggregates._call` replaces `kwargs["crop"]` with `crop_catalog.resolve_crop(...)` before any impl runs.
  - Fixture: `crop_scoping_fixture.WEEK_A/B/C/D` (`(from, to)` tuples), `rose_greenhouse() -> str`, `avocado_block() -> str`, `insert_entry(*, greenhouse=None, block=None, crop=None, date, pests=(), diseases=()) -> str`, `add_creator_roster(farm, user="Administrator") -> None`, `PETER`.

- [ ] **Step 1: Create the fixture** — `upande_scp/serverscripts/tests/crop_scoping_fixture.py`

```python
"""Raw-SQL Scouting Entries for the crop-scoping tests.

Raw inserts skip the Scouting Entry controller and the doc events that bust the
caches. Callers therefore roll back in tearDown, pass ``force="1"`` to cached
aggregates, and delete any observations week key they touch.

Dates are in 2031 — no real data exists there (kaitet.local max is 2026-09), so a
window holds only what the test inserted. Each test module uses its own ISO week so
cached results from one module can never satisfy another's assertions.
"""

import frappe
from frappe.utils import now

WEEK_A = ("2031-01-06", "2031-01-12")  # 2031-W02 — test_crop_scoped_aggregates
WEEK_B = ("2031-01-13", "2031-01-19")  # 2031-W03 — test_crop_scoped_aggregate_detail
WEEK_C = ("2031-01-20", "2031-01-26")  # 2031-W04 — test_crop_scoped_observations
WEEK_D = ("2031-01-27", "2031-02-02")  # 2031-W05 — test_crop_scoped_spray_plan

PETER = "pkamuren@karenroses.com"  # SCP General Manager at Karen Roses: Rose only


def _first(sql, params=None):
    rows = frappe.db.sql(sql, params or {})
    return rows[0][0] if rows else None


def rose_greenhouse() -> str:
    farms = tuple(r[0] for r in frappe.db.sql(
        "select farm from `tabFarm Filter` where parenttype='Crop Scouted' and parent='Rose'"))
    return _first(
        """select name from `tabWarehouse` where custom_farm in %(f)s and is_group=0
           and warehouse_type='Greenhouse' and disabled=0 and name like '%%GH%%'
           order by name limit 1""",
        {"f": farms},
    )


def avocado_block() -> str:
    return _first(
        """select name from `tabWarehouse` where custom_farm='Lokitela' and is_group=0
           and warehouse_type='Block' and disabled=0 order by name limit 1""")


def _scout() -> str:
    return _first("select name from `tabEmployee` order by name limit 1")


def insert_entry(*, greenhouse=None, block=None, crop=None, date, pests=(), diseases=()) -> str:
    """One Scouting Entry with optional pest/disease child rows. Returns its name."""
    name = "_TEST-CS-" + frappe.generate_hash(length=10)
    where = greenhouse or block
    stamp = now()
    frappe.db.sql(
        """insert into `tabScouting Entry`
           (name, creation, modified, owner, modified_by, docstatus, idx, naming_series,
            scouts_name, greenhouse, block, zone, bed, date_of_capture, time_of_capture,
            crop_scouted, latitude, longitude)
           values (%(name)s, %(ts)s, %(ts)s, 'Administrator', 'Administrator', 0, 0,
            'SCE-.YYYY.-', %(scout)s, %(gh)s, %(block)s, %(zone)s, %(bed)s, %(date)s,
            '08:00:00', %(crop)s, '0', '0')""",
        {
            "name": name, "ts": stamp, "scout": _scout(),
            "gh": greenhouse, "block": block,
            "zone": f"{where} - Bed 1 - Zone 1", "bed": f"{where} - Bed 1",
            "date": date, "crop": crop,
        },
    )
    for i, pest in enumerate(pests, start=1):
        frappe.db.sql(
            """insert into `tabPests Scouting Entry`
               (name, creation, modified, owner, modified_by, docstatus, idx, parent,
                parenttype, parentfield, pest, stage, plant_section, `count`)
               values (%(n)s, %(ts)s, %(ts)s, 'Administrator', 'Administrator', 0, %(i)s,
                %(p)s, 'Scouting Entry', 'pests_scouting_entry', %(pest)s, 'Adult', 'Leaf', 3)""",
            {"n": frappe.generate_hash(length=12), "ts": stamp, "i": i, "p": name, "pest": pest},
        )
    for i, disease in enumerate(diseases, start=1):
        frappe.db.sql(
            """insert into `tabDiseases Scouting Entry`
               (name, creation, modified, owner, modified_by, docstatus, idx, parent,
                parenttype, parentfield, disease, stage, plant_section)
               values (%(n)s, %(ts)s, %(ts)s, 'Administrator', 'Administrator', 0, %(i)s,
                %(p)s, 'Scouting Entry', 'diseases_scouting_entry', %(d)s, 'Active', 'Leaf')""",
            {"n": frappe.generate_hash(length=12), "ts": stamp, "i": i, "p": name, "d": disease},
        )
    return name


def add_creator_roster(farm: str, user: str = "Administrator") -> None:
    """Put `user` on a farm's Spray Plan Creator roster (raw, rolled back)."""
    frappe.db.sql(
        """insert into `tabFarm Spray Plan Creator`
           (name, creation, modified, owner, modified_by, docstatus, idx, user,
            parent, parentfield, parenttype)
           values (%(n)s, %(ts)s, %(ts)s, 'Administrator', 'Administrator', 0, 99, %(u)s,
            %(f)s, 'spray_plan_creators', 'Farm')""",
        {"n": "_TEST-CS-" + frappe.generate_hash(length=10), "ts": now(), "u": user, "f": farm},
    )
```

- [ ] **Step 2: Write the failing test** — `upande_scp/serverscripts/tests/test_crop_scoped_aggregates.py`

```python
"""Overview + Trends honour D4/D5 and the route crop. DB test — direct runner."""

import unittest

import frappe

from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.tests import crop_scoping_fixture as F

FROM, TO = F.WEEK_A
AVOCADO_PEST = "Fruit fly (Ceratitis)"   # Avocado Pest Filter only
AVOCADO_DISEASE = "Avocado Scab"         # Avocado Disease Filter only


def _overview(crop, force="1"):
    kw = {"from_date": FROM, "to_date": TO, "crop": crop}
    if force:
        kw["force"] = force
    return DA.overview(**kw)


class TestCropScopedAggregates(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()

    def tearDown(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        frappe.db.rollback()

    def test_a_crop_less_entry_counts_once_under_its_greenhouse_crop(self):
        F.insert_entry(greenhouse=self.gh, crop=None, date=FROM, pests=["Thrips"])
        rose = _overview("Rose")
        self.assertEqual(rose["kpis"]["zonesScouted"], 1)
        self.assertEqual(rose["rangeTotals"]["pests"], 1)
        self.assertEqual(_overview("Avocado")["kpis"]["zonesScouted"], 0)

    def test_off_crop_children_are_excluded(self):
        F.insert_entry(greenhouse=self.gh, crop="Rose", date=FROM,
                       pests=["Thrips", AVOCADO_PEST], diseases=["Powdery Mildew", AVOCADO_DISEASE])
        totals = _overview("Rose")["rangeTotals"]
        self.assertEqual((totals["pests"], totals["diseases"]), (1, 1))

    def test_trends_options_are_crop_only(self):
        F.insert_entry(greenhouse=self.gh, crop="Rose", date=FROM,
                       pests=["Thrips", AVOCADO_PEST], diseases=["Powdery Mildew", AVOCADO_DISEASE])
        opts = DA.trends(from_date=FROM, to_date=TO, crop="Rose", force="1")["options"]
        self.assertEqual(set(opts["pests"]), {"Thrips"})
        self.assertEqual(set(opts["diseases"]), {"Powdery Mildew"})

    def test_a_clean_crop_less_entry_is_in_the_trends_denominator(self):
        F.insert_entry(greenhouse=self.gh, crop=None, date=FROM)
        rose = DA.trends(from_date=FROM, to_date=TO, crop="Rose", force="1")
        self.assertIn(self.gh, rose["vocab"]["stations"])
        avo = DA.trends(from_date=FROM, to_date=TO, crop="Avocado", force="1")
        self.assertNotIn(self.gh, avo["vocab"]["stations"])

    def test_one_crops_payload_is_not_served_to_another(self):
        F.insert_entry(greenhouse=self.gh, crop="Rose", date=FROM, pests=["Thrips"])
        self.assertEqual(_overview("Rose")["kpis"]["zonesScouted"], 1)
        # Not forced: must read Avocado's own key, never Rose's.
        self.assertEqual(_overview("Avocado", force=None)["kpis"]["zonesScouted"], 0)

    def test_a_lowercase_route_crop_shares_the_canonical_cache_entry(self):
        F.insert_entry(greenhouse=self.gh, crop="Rose", date=FROM, pests=["Thrips"])
        self.assertEqual(_overview("Rose")["kpis"]["zonesScouted"], 1)
        self.assertEqual(_overview("rose", force=None)["kpis"]["zonesScouted"], 1)

    def test_an_unknown_crop_is_refused(self):
        with self.assertRaises(frappe.PermissionError):
            _overview("Mango")

    def test_a_rose_only_user_is_refused_avocado_aggregates(self):
        if not frappe.db.exists("Employee", {"user_id": F.PETER}):
            self.skipTest("Peter Kamuren has no Employee record on this site")
        frappe.set_user(F.PETER)
        with self.assertRaises(frappe.PermissionError):
            _overview("Avocado")

    def test_no_crop_keeps_todays_unfiltered_behaviour(self):
        F.insert_entry(greenhouse=self.gh, crop=None, date=FROM, pests=[AVOCADO_PEST])
        F.insert_entry(block=F.avocado_block(), crop="Avocado", date=FROM, pests=[AVOCADO_PEST])
        all_crops = _overview("")
        self.assertEqual(all_crops["kpis"]["zonesScouted"], 2)
        self.assertEqual(all_crops["rangeTotals"]["pests"], 2)
```

- [ ] **Step 3: Run it and watch it fail**

DB-RUN `test_crop_scoped_aggregates`
Expected: `test_a_crop_less_entry_counts_once…` fails (`0 != 1`), `test_off_crop_children_are_excluded` fails (`(2, 2) != (1, 1)`), `test_trends_options_are_crop_only` fails, `test_a_lowercase…` fails (`0 != 1` — "rose" hits a different key), `test_an_unknown_crop_is_refused` and the Peter test fail (`PermissionError not raised`).

- [ ] **Step 4: `_common.py`**

After `import frappe` add:

```python
from upande_scp.serverscripts.common import crop_catalog
```

After `K_DASH_AGG_PREFIX = "scp:dash_agg"` add:

```python
# Bumped when an aggregate's meaning changes without its filters changing, so a
# deploy never serves a payload computed under the old rules. "crop2": crop-less
# entries count under their greenhouse's crop and off-crop pests/diseases drop out.
K_DASH_AGG_SCHEMA = "crop2"
```

Replace `_build_key`'s return line with:

```python
    return f"{K_DASH_AGG_PREFIX}:v{dash_agg_version()}:{K_DASH_AGG_SCHEMA}:{endpoint}:{filter_hash(filters)}"
```

In `parent_filter_conditions`, replace

```python
    if crop:
        parts.append("se.crop_scouted = %(crop)s")
        params["crop"] = crop
```

with

```python
    if crop:
        # D5: an entry with no crop counts under its greenhouse's crop. The
        # params also carry the crop's pest/disease lists for obs_filter (D4).
        parts.append(crop_catalog.entry_crop_condition("se"))
        params.update(crop_catalog.crop_sql_params(crop))
```

Add directly after `parent_filter_conditions`:

```python
def obs_filter(kind: str, column: str, params: dict) -> str:
    """D4: ``" AND <column> IN (the crop's pests|diseases)"``.

    Keyed off the params ``parent_filter_conditions`` produced, so a query only
    has to pass what it already has; ``""`` when no crop is in play.
    """
    if "crop_pests" not in params:
        return ""
    return " AND " + crop_catalog.obs_crop_condition(kind, column)
```

- [ ] **Step 5: `__init__.py`** — add `from upande_scp.serverscripts.common import crop_catalog` after `import frappe`, and replace `_call` with:

```python
def _call(impl, **kwargs):
    """Common entry: read force flag, drop it, resolve the crop, delegate.

    The crop is canonicalised and access-checked here, once, so every aggregate's
    cache key holds `Rose` (never `rose`) and a user can never ask for a crop
    they may not see.
    """
    force = _truthy(kwargs.pop("force", "")) if "force" in kwargs else False
    if "crop" in kwargs:
        kwargs["crop"] = crop_catalog.resolve_crop(kwargs.get("crop"))
    return impl(kwargs, force=force)
```

- [ ] **Step 6: `_overview.py`** — add `obs_filter,` to the `_common` import list. In `_observation_rows`, before `return frappe.db.sql(` add:

```python
    pest_obs = obs_filter("pest", "p.pest", params)
    disease_obs = obs_filter("disease", "d.disease", params)
```

and change the two child-table branches:

```
        JOIN `tabPests Scouting Entry` p ON p.parent = se.name
        WHERE {where}{pest_obs}
```
```
        JOIN `tabDiseases Scouting Entry` d ON d.parent = se.name
        WHERE {where}{disease_obs}
```

(the trap branch stays `WHERE {where}`). In `_recent_activity`, before `rows = frappe.db.sql(` add the same two `pest_obs` / `disease_obs` lines and change the two EXISTS lines to:

```
               EXISTS(SELECT 1 FROM `tabPests Scouting Entry` p WHERE p.parent = se.name{pest_obs})    AS has_pest,
               EXISTS(SELECT 1 FROM `tabDiseases Scouting Entry` d WHERE d.parent = se.name{disease_obs}) AS has_disease,
```

- [ ] **Step 7: `_trends.py`** — add `obs_filter,` to the `_common` import list. In `_fetch_observations`, before `return frappe.db.sql(` add the same `pest_obs` / `disease_obs` lines and change the two `WHERE {where}` lines to `WHERE {where}{pest_obs}` (pest branch) and `WHERE {where}{disease_obs}` (disease branch). `_fetch_scouted` is unchanged (it has no child join; D5 reaches it through `where`).

- [ ] **Step 8: Run the tests**

DB-RUN `test_crop_scoped_aggregates` → `Ran 9 tests … OK` (Peter test may report `skipped`).
DB-RUN `test_dashboard_aggregates_common` → `Ran 18 tests … OK` (`test_crop_clause_added` still finds `se.crop_scouted = %(crop)s`).
`cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_dashboard_aggregates_trends.py` → `20 passed`.

- [ ] **Step 9: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/_common.py upande_scp/serverscripts/dashboard_aggregates/__init__.py \
  upande_scp/serverscripts/dashboard_aggregates/_overview.py upande_scp/serverscripts/dashboard_aggregates/_trends.py \
  upande_scp/serverscripts/tests/crop_scoping_fixture.py upande_scp/serverscripts/tests/test_crop_scoped_aggregates.py
git commit -m "feat(scp): overview and trends count crop-less entries under their greenhouse's crop and drop other crops' pests"
```

---

### Task 3: Aggregates detail — Pests/Diseases tabs, greenhouse detail, heatmaps

**Files:**
- Create: `upande_scp/serverscripts/tests/test_crop_scoped_aggregate_detail.py`
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_pests_diseases.py` (import :7-13; `_build` query :63-76)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_gh_detail.py` (import :6-11; pest/disease queries :42-56)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_heatmaps.py` (imports :28-34; `_latest_scouting_date` :116-132; `_query_kind` :135-167; `scouts_and_coverage` :472-476)

**Interfaces:**
- Consumes: `_common.obs_filter(kind, column, params)`, `crop_catalog.entry_crop_condition`, `crop_catalog.crop_sql_params` (Task 1/2).
- Produces: no new signatures. `_heatmaps._latest_scouting_date(crop)` and `scouts_and_coverage(greenhouse, from_date, to_date, crop)` keep their signatures and now apply D5.

- [ ] **Step 1: Write the failing test** — `upande_scp/serverscripts/tests/test_crop_scoped_aggregate_detail.py`

```python
"""Pests/Diseases tabs, greenhouse detail and heatmaps honour D4/D5. DB test."""

import unittest

import frappe

from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.dashboard_aggregates import _heatmaps as H
from upande_scp.serverscripts.dashboard_aggregates._trends import week_key
from upande_scp.serverscripts.tests import crop_scoping_fixture as F

FROM, TO = F.WEEK_B
AVOCADO_PEST = "Fruit fly (Ceratitis)"
AVOCADO_DISEASE = "Avocado Scab"


class TestCropScopedDetail(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()
        F.insert_entry(greenhouse=self.gh, crop="Rose", date=FROM,
                       pests=["Thrips", AVOCADO_PEST], diseases=["Powdery Mildew", AVOCADO_DISEASE])
        F.insert_entry(greenhouse=self.gh, crop=None, date="2031-01-15", pests=["Aphids"])

    def tearDown(self):
        crop_scope.clear_cache()
        frappe.db.rollback()

    def test_pests_tab_offers_only_the_crops_pests(self):
        out = DA.pests(from_date=FROM, to_date=TO, crop="Rose", force="1")
        self.assertEqual(out["filterOptions"]["pests"], ["Aphids", "Thrips"])

    def test_diseases_tab_offers_only_the_crops_diseases(self):
        out = DA.diseases(from_date=FROM, to_date=TO, crop="Rose", force="1")
        self.assertEqual(out["filterOptions"]["diseases"], ["Powdery Mildew"])

    def test_greenhouse_detail(self):
        rose = DA.greenhouse_detail(greenhouse=self.gh, from_date=FROM, to_date=TO, crop="Rose", force="1")
        self.assertEqual({p["name"] for p in rose["topPests"]}, {"Thrips", "Aphids"})
        self.assertEqual({d["name"] for d in rose["topDiseases"]}, {"Powdery Mildew"})
        avo = DA.greenhouse_detail(greenhouse=self.gh, from_date=FROM, to_date=TO, crop="Avocado", force="1")
        self.assertEqual(avo["topPests"], [])

    def test_heatmap_cards_are_crop_only(self):
        out = DA.heatmaps_grid(from_date=FROM, to_date=TO, crop="Rose", force="1")
        names = {c["obsName"] for c in out["cards"]}
        self.assertEqual(names, {"Thrips", "Aphids", "Powdery Mildew"})

    def test_latest_scouting_date_sees_crop_less_entries(self):
        self.assertEqual(H._latest_scouting_date("Rose"), "2031-01-15")
        self.assertNotEqual(H._latest_scouting_date("Avocado"), "2031-01-15")

    def test_coverage_counts_crop_less_entries(self):
        cov = H.scouts_and_coverage(self.gh, FROM, TO, "Rose")
        self.assertIn(week_key("2031-01-15"), cov)
```

- [ ] **Step 2: Run it and watch it fail**

DB-RUN `test_crop_scoped_aggregate_detail`
Expected: the pests/diseases/heatmap tests fail with the avocado names present (e.g. `['Aphids', 'Fruit fly (Ceratitis)', 'Thrips'] != ['Aphids', 'Thrips']`); `test_latest_scouting_date…` fails (`'2031-01-13' != '2031-01-15'`, the crop-less row is invisible to `crop_scouted = 'Rose'`).

- [ ] **Step 3: `_pests_diseases.py`** — add `obs_filter,` to the `_common` import. In `_build`, before `rows = frappe.db.sql(` add `child_obs = obs_filter(kind, f"c.{col}", params)` and change the query tail to:

```
        FROM `tabScouting Entry` se
        JOIN `{table}` c ON c.parent = se.name
        WHERE {where}{child_obs}
```

- [ ] **Step 4: `_gh_detail.py`** — add `obs_filter,` to the `_common` import. In `_build`, after `where, params = parent_filter_conditions(...)` add:

```python
    pest_obs = obs_filter("pest", "p.pest", params)
    disease_obs = obs_filter("disease", "d.disease", params)
```

and change the pest query's `WHERE {where}` (the one after `JOIN \`tabPests Scouting Entry\` p`) to `WHERE {where}{pest_obs}`, and the disease query's (after `JOIN \`tabDiseases Scouting Entry\` d`) to `WHERE {where}{disease_obs}`. The trap and scout queries are unchanged.

- [ ] **Step 5: `_heatmaps.py`** — add `obs_filter,` to the `_common` import and `from upande_scp.serverscripts.common import crop_catalog` to the imports.

`_query_kind`: before `return frappe.db.sql(` add `child_obs = obs_filter(mode, f"c.{col}", params)` and change `WHERE {where}` to `WHERE {where}{child_obs}`.

Replace `_latest_scouting_date`'s body after the docstring with:

```python
    where = "1=1"
    params: dict = {}
    if crop:
        where = crop_catalog.entry_crop_condition("se")
        params.update(crop_catalog.crop_sql_params(crop))
    row = frappe.db.sql(
        f"SELECT MAX(se.date_of_capture) AS d FROM `tabScouting Entry` se WHERE {where}",
        params,
    )
    return str(row[0][0])[:10] if row and row[0] and row[0][0] else ""
```

In `scouts_and_coverage`, replace

```python
    if crop:
        where.append("se.crop_scouted = %(crop)s")
        params["crop"] = crop
```

with

```python
    if crop:
        where.append(crop_catalog.entry_crop_condition("se"))
        params.update(crop_catalog.crop_sql_params(crop))
```

- [ ] **Step 6: Run the tests**

DB-RUN `test_crop_scoped_aggregate_detail` → `Ran 6 tests … OK`.
DB-RUN `test_crop_scoped_aggregates` → `OK` (no regression).

- [ ] **Step 7: Commit**

```bash
git add upande_scp/serverscripts/dashboard_aggregates/_pests_diseases.py upande_scp/serverscripts/dashboard_aggregates/_gh_detail.py \
  upande_scp/serverscripts/dashboard_aggregates/_heatmaps.py upande_scp/serverscripts/tests/test_crop_scoped_aggregate_detail.py
git commit -m "feat(scp): pests, diseases, greenhouse detail and heatmaps list only the route crop's observations"
```

---

### Task 4: Observations payload, farm lists and the week-slice cache

**Files:**
- Create: `upande_scp/serverscripts/tests/test_crop_scoped_observations.py`
- Modify: `upande_scp/serverscripts/scouting/get_complete_scouting_entries.py` (constants :85; `_fetch_week_entries` :172-199; `_build_month_entries` :265-347; `getScoutingEntriesChunk` :366-398)
- Modify: `upande_scp/serverscripts/scouting/scouting_metrics_api.py` (imports :17; `get_farms_and_warehouses` :88-106)
- Modify: `upande_scp/serverscripts/common/cache_utils.py` (`_resolve_scouting_crop` :161-171; `invalidate_scouting_week_for_doc` :174-200)
- Modify: `upande_scp/serverscripts/tests/test_cache_invalidation.py` (append a class)

**Interfaces:**
- Consumes: `crop_catalog.resolve_crop`, `crop_sql_params`, `entry_crop_condition`, `crop_for_greenhouse`.
- Produces:
  - `get_complete_scouting_entries.SPARSE_SLICE_MAX = 5000`
  - `getScoutingEntriesChunk(from_date, to_date, greenhouse=None, include_meta=0, crop=None)` — `crop` resolved; crop slice = D5 entries with D4 children.
  - `scouting_metrics_api.get_farms_and_warehouses(crop=None)` — `crop` resolved (canonical; unknown/not-allowed refused).
  - `cache_utils._resolve_scouting_crop(doc) -> str | None` — falls back to the greenhouse's crop.

- [ ] **Step 1: Write the failing DB test** — `upande_scp/serverscripts/tests/test_crop_scoped_observations.py`

```python
"""Observations week slices + farm lists by crop. DB test — direct runner."""

import unittest
from unittest.mock import patch

import frappe

from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.scouting import get_complete_scouting_entries as G
from upande_scp.serverscripts.scouting import scouting_metrics_api as API
from upande_scp.serverscripts.tests import crop_scoping_fixture as F

FROM, TO = F.WEEK_C  # 2031-W04


def _drop_week_keys():
    for crop in (None, "Rose", "Avocado", "Coffee"):
        frappe.cache().delete_value(G._week_cache_key(2031, 4, crop))


class TestCropScopedObservations(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        _drop_week_keys()
        self.gh = F.rose_greenhouse()
        self.rose = F.insert_entry(greenhouse=self.gh, crop="Rose", date=FROM,
                                   pests=["Thrips", "Fruit fly (Ceratitis)"])
        self.crop_less = F.insert_entry(greenhouse=self.gh, crop=None, date=FROM)
        self.avo = F.insert_entry(block=F.avocado_block(), crop="Avocado", date=FROM,
                                  pests=["Fruit fly (Ceratitis)"])

    def tearDown(self):
        _drop_week_keys()
        crop_scope.clear_cache()
        frappe.db.rollback()

    def _names(self, payload):
        return [e["name"] for e in payload["entries"]]

    def test_rose_slice_has_crop_less_rows_once(self):
        names = self._names(G.getScoutingEntriesChunk(from_date=FROM, to_date=TO, crop="rose"))
        self.assertIn(self.rose, names)
        self.assertIn(self.crop_less, names)
        self.assertNotIn(self.avo, names)
        self.assertEqual(len(names), len(set(names)))

    def test_other_crops_pests_are_not_returned(self):
        entries = G.getScoutingEntriesChunk(from_date=FROM, to_date=TO, crop="Rose")["entries"]
        rose = next(e for e in entries if e["name"] == self.rose)
        self.assertEqual([p["pest"] for p in rose["pests"]], ["Thrips"])

    def test_crop_slices_are_cached_per_crop(self):
        G.getScoutingEntriesChunk(from_date=FROM, to_date=TO, crop="Rose")
        names = self._names(G.getScoutingEntriesChunk(from_date=FROM, to_date=TO, crop="Avocado"))
        self.assertEqual(names, [self.avo])

    def test_a_dense_slice_outside_the_window_is_not_cached(self):
        with patch.object(G, "SPARSE_SLICE_MAX", 0):
            G.getScoutingEntriesChunk(from_date=FROM, to_date=TO, crop="Rose")
        self.assertIsNone(frappe.cache().get_value(G._week_cache_key(2031, 4, "Rose")))

    def test_an_unknown_crop_is_refused(self):
        with self.assertRaises(frappe.PermissionError):
            G.getScoutingEntriesChunk(from_date=FROM, to_date=TO, crop="Mango")

    def test_farm_lists_follow_the_crop(self):
        rose_farms = set(crop_scope.farms_for_crop("Rose"))
        rose = API.get_farms_and_warehouses("rose")
        self.assertTrue(rose)
        self.assertLessEqual(set(rose), rose_farms)
        self.assertNotIn("Lokitela", rose)
        self.assertEqual(set(API.get_farms_and_warehouses("Avocado")), {"Lokitela"})
        with self.assertRaises(frappe.PermissionError):
            API.get_farms_and_warehouses("Mango")
```

- [ ] **Step 2: Append the pure invalidation tests** to `upande_scp/serverscripts/tests/test_cache_invalidation.py`

```python
class TestCropSliceInvalidation(unittest.TestCase):
    def test_a_rose_write_busts_the_rose_slice_too(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        doc = SimpleNamespace(doctype="Scouting Entry", date_of_capture="2025-05-01",
                              crop_scouted="Rose", greenhouse="GH")
        with patch.object(cu, "scouting_payload_version", return_value=7), \
             patch.object(cu, "invalidate") as inv:
            cu.invalidate_scouting_week_for_doc(doc)
        self.assertEqual(
            [c.args[0] for c in inv.call_args_list],
            [f"{cu.K_SCOUTING_PAYLOAD_PREFIX}:7:2025-W18",
             f"{cu.K_SCOUTING_PAYLOAD_PREFIX}:7:Rose:2025-W18"],
        )

    def test_a_crop_less_write_busts_its_greenhouse_crop(self):
        from upande_scp.serverscripts.common import cache_utils as cu
        from upande_scp.serverscripts.common import crop_catalog
        doc = SimpleNamespace(doctype="Scouting Entry", date_of_capture="2025-05-01",
                              crop_scouted=None, greenhouse="Chepsito GH 01 - KR")
        with patch.object(cu, "scouting_payload_version", return_value=7), \
             patch.object(crop_catalog, "crop_for_greenhouse", return_value="Rose"), \
             patch.object(cu, "invalidate") as inv:
            cu.invalidate_scouting_week_for_doc(doc)
        self.assertIn(f"{cu.K_SCOUTING_PAYLOAD_PREFIX}:7:Rose:2025-W18",
                      [c.args[0] for c in inv.call_args_list])
```

- [ ] **Step 3: Run them and watch them fail**

DB-RUN `test_crop_scoped_observations` → `test_rose_slice…` fails (crop-less entry missing), `test_other_crops_pests…` fails (`['Thrips', 'Fruit fly (Ceratitis)'] != ['Thrips']`), `test_a_dense_slice…` fails (`AttributeError: … has no attribute 'SPARSE_SLICE_MAX'`), unknown-crop tests fail (`PermissionError not raised`).
`cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_cache_invalidation.py` → the two new tests fail (Rose slice not busted; crop-less resolves to `None`).

- [ ] **Step 4: `get_complete_scouting_entries.py`**

Add `from upande_scp.serverscripts.common import crop_catalog` to the imports. After `CACHE_WINDOW_DAYS = 90 …` add:

```python
# A crop slice older than the rolling window is cached only while it is small.
# Avocado's weeks are a few hundred rows and cache for all history (what makes
# its 10-month map fast); a Rose week is the dense one the window exists for.
SPARSE_SLICE_MAX = 5000
```

In `_fetch_week_entries` replace `if crop or _is_recent_week(iso_year, iso_week):` with:

```python
    if _is_recent_week(iso_year, iso_week) or (crop and len(entries) <= SPARSE_SLICE_MAX):
```

In `_build_month_entries`, replace from `_filters = [["date_of_capture", "between", [from_date, to_date]]]` down to (and including) the closing `)` of the `scouting_entries = frappe.get_all(...)` call with:

```python
    crop_params = crop_catalog.crop_sql_params(crop) if crop else None
    if crop_params:
        # D5 in SQL: the crop's rows plus crop-less rows in its greenhouses, in
        # one query so no entry can appear twice. Raw SQL rather than get_all:
        # the slice is cached site-wide, so it must not carry the first
        # caller's permission scope (the crop itself is checked at the endpoint).
        scouting_entries = frappe.db.sql(
            f"""
            SELECT se.name, se.scouts_name, se.greenhouse, se.bed, se.zone, se.block,
                   se.`row`, se.tree, se.crop_scouted, se.time_of_capture,
                   se.date_of_capture, se.latitude, se.longitude
            FROM `tabScouting Entry` se
            WHERE se.date_of_capture BETWEEN %(from_date)s AND %(to_date)s
              AND {crop_catalog.entry_crop_condition("se")}
            ORDER BY se.date_of_capture DESC, se.time_of_capture DESC
            """,
            {"from_date": from_date, "to_date": to_date, **crop_params},
            as_dict=True,
        )
    else:
        scouting_entries = frappe.get_all(
            "Scouting Entry",
            filters=[["date_of_capture", "between", [from_date, to_date]]],
            fields=[
                "name",
                "scouts_name",
                "greenhouse",
                "bed",
                "zone",
                "block",
                "`row`",
                "tree",
                "crop_scouted",
                "time_of_capture",
                "date_of_capture",
                "latitude",
                "longitude",
            ],
            order_by="date_of_capture desc, time_of_capture desc",
            limit_page_length=0,
        )
```

Then replace the `pests = frappe.get_all(...)` and `diseases = frappe.get_all(...)` calls with:

```python
    pest_filters = [["parent", "in", entry_names]]
    disease_filters = [["parent", "in", entry_names]]
    if crop_params:
        # D4: another crop's pest/disease rows are not returned at all.
        pest_filters.append(["pest", "in", list(crop_params["crop_pests"])])
        disease_filters.append(["disease", "in", list(crop_params["crop_diseases"])])
    pests = frappe.get_all(
        "Pests Scouting Entry",
        filters=pest_filters,
        fields=["parent", "plant_section", "pest", "stage", "count"],
        limit_page_length=0,
    )
    diseases = frappe.get_all(
        "Diseases Scouting Entry",
        filters=disease_filters,
        fields=["parent", "disease", "plant_section", "stage"],
        limit_page_length=0,
    )
```

(The trap query is unchanged — traps carry no crop.) In `getScoutingEntriesChunk`, move crop handling **before** the `try:` (the `except` re-throws everything as a plain `ValidationError`, which would hide the 403):

```python
    crop = crop_catalog.resolve_crop(crop or frappe.form_dict.get("crop")) or None
    try:
        from_date = from_date or frappe.form_dict.get("from_date")
        ...
```

and delete the old `crop = crop or frappe.form_dict.get("crop") or None` line inside the `try`.

- [ ] **Step 5: `scouting_metrics_api.py`** — change the import line to `from upande_scp.serverscripts.common import crop_catalog, crop_scope`, and in `get_farms_and_warehouses` insert before `allowed = crop_scope.scoped_farms(...)`:

```python
    crop = crop_catalog.resolve_crop(crop) or None
```

- [ ] **Step 6: `cache_utils.py`** — replace `_resolve_scouting_crop` with:

```python
def _resolve_scouting_crop(doc):
    """Best-effort crop for a scouting-related doc (child rows walk to their
    parent). A row with no ``crop_scouted`` belongs to its greenhouse's crop
    (spec D5), because that is the slice it is served in. ``None`` when
    unresolvable."""
    dt = getattr(doc, "doctype", None)
    crop = greenhouse = None
    if dt == "Scouting Entry":
        crop = getattr(doc, "crop_scouted", None)
        greenhouse = getattr(doc, "greenhouse", None)
    elif dt in ("Pests Scouting Entry", "Diseases Scouting Entry", "Trap Scouting Entry"):
        parent = getattr(doc, "parent", None)
        if parent:
            row = frappe.db.get_value(
                "Scouting Entry", parent, ["crop_scouted", "greenhouse"], as_dict=True
            ) or {}
            crop, greenhouse = row.get("crop_scouted"), row.get("greenhouse")
    if crop:
        return crop
    if greenhouse:
        from upande_scp.serverscripts.common import crop_catalog

        return crop_catalog.crop_for_greenhouse(greenhouse)
    return None
```

and in `invalidate_scouting_week_for_doc` replace

```python
    crop = _resolve_scouting_crop(doc)
    if crop and crop != "Rose":
        invalidate_scouting_week(iso[0], iso[1], crop)
```

with

```python
    # Rose is a scoped slice too now (the route always sends the crop).
    crop = _resolve_scouting_crop(doc)
    if crop:
        invalidate_scouting_week(iso[0], iso[1], crop)
```

- [ ] **Step 7: Run the tests**

DB-RUN `test_crop_scoped_observations` → `Ran 6 tests … OK`.
DB-RUN `test_get_complete_scouting_entries` → `Ran 11 tests … OK`.
`cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_cache_invalidation.py` → `11 passed`.

- [ ] **Step 8: Commit**

```bash
git add upande_scp/serverscripts/scouting/get_complete_scouting_entries.py upande_scp/serverscripts/scouting/scouting_metrics_api.py \
  upande_scp/serverscripts/common/cache_utils.py upande_scp/serverscripts/tests/test_crop_scoped_observations.py \
  upande_scp/serverscripts/tests/test_cache_invalidation.py
git commit -m "feat(scp): observation slices and farm lists are scoped to the route crop on the server"
```

---

### Task 5: Spray plan server — bootstrap by crop, diagnose by greenhouse crop, target validation

**Files:**
- Create: `upande_scp/serverscripts/tests/test_crop_scoped_spray_plan.py`
- Modify: `upande_scp/serverscripts/spray_plan_creator/bootstrap.py` (imports :4-15; `fetch_creator_bootstrap` :18-196)
- Modify: `upande_scp/serverscripts/dashboard_aggregates/_application_plan.py` (imports :11-21; `application_plan_diagnose` :24-52; `_query_kind` :206-253)
- Modify: `upande_scp/serverscripts/spray_plan_creator/validation.py` (imports :10-14; `validate_targets_in_scope` :178-212)
- Modify: `upande_scp/serverscripts/spray_plan_creator/drafts.py` (imports :9; `_validate_payload` :384-393)

**Interfaces:**
- Consumes: `crop_catalog.resolve_crop`, `pests_for_crop`, `diseases_for_crop`, `targets_for_crop`, `crop_for_greenhouse`, `entry_crop_condition`, `obs_crop_condition`, `crop_sql_params`; `crop_scope.scoped_farms(crop, user)`.
- Produces:
  - `fetch_creator_bootstrap(crop: str | None = None) -> dict` (whitelisted; same keys as today).
  - `bootstrap._narrow_to_crop(scope: dict, crop: str, user: str) -> dict`.
  - `validate_targets_in_scope(classification, targets, *, greenhouse=None, days=60, crop=None) -> None`; off-crop targets raise `frappe.ValidationError` titled `Target not for this crop`, message naming the crop.
  - Diagnose: `application_plan_diagnose(args, force)` derives `crop = crop_for_greenhouse(greenhouse) or args["crop"]`; cache endpoint name becomes `application_plan_rows_v2`.

- [ ] **Step 1: Write the failing test** — `upande_scp/serverscripts/tests/test_crop_scoped_spray_plan.py`

```python
"""Spray-plan bootstrap / diagnose / validation by crop. DB test — direct runner."""

import unittest
from unittest.mock import patch

import frappe
from frappe.utils import today

from upande_scp.serverscripts import dashboard_aggregates as DA
from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.spray_plan_creator import bootstrap as B
from upande_scp.serverscripts.spray_plan_creator import drafts as D
from upande_scp.serverscripts.spray_plan_creator.validation import validate_targets_in_scope
from upande_scp.serverscripts.tests import crop_scoping_fixture as F

FROM, TO = F.WEEK_D
AVOCADO_PEST = "Fruit fly (Ceratitis)"
AVOCADO_DISEASE = "Avocado Scab"


class TestBootstrapByCrop(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        F.add_creator_roster("Chepsito")
        F.add_creator_roster("Lokitela")

    def tearDown(self):
        frappe.set_user("Administrator")
        crop_scope.clear_cache()
        frappe.db.rollback()

    def test_rose_lists_no_avocado_farm_block_or_target(self):
        b = B.fetch_creator_bootstrap(crop="rose")
        rose_farms = crop_scope.farms_for_crop("Rose")
        self.assertIn("Chepsito", b["scope"]["farms"])
        self.assertNotIn("Lokitela", b["scope"]["farms"])
        self.assertTrue(all(g["custom_farm"] in rose_farms for g in b["greenhouses"]))
        self.assertTrue(all(x["custom_farm"] in rose_farms for x in b["blocks"]))
        self.assertEqual([p["name"] for p in b["pest_catalog"]], sorted(crop_catalog.pests_for_crop("Rose")))
        self.assertNotIn(AVOCADO_DISEASE, [d["name"] for d in b["disease_catalog"]])
        farms = set(b["scope"]["farms"])
        self.assertTrue(all(not t.get("custom_farm") or t["custom_farm"] in farms for t in b["tank_mixes"]))
        self.assertLessEqual(set(b["farm_stores"]), farms)

    def test_avocado_lists_lokitela_blocks_only(self):
        b = B.fetch_creator_bootstrap(crop="Avocado")
        self.assertEqual(b["scope"]["farms"], ["Lokitela"])
        self.assertTrue(b["blocks"])
        self.assertTrue(all(x["custom_farm"] == "Lokitela" for x in b["blocks"]))
        self.assertIn(AVOCADO_DISEASE, [d["name"] for d in b["disease_catalog"]])

    def test_no_crop_keeps_the_full_catalog(self):
        b = B.fetch_creator_bootstrap()
        self.assertEqual(len(b["pest_catalog"]), frappe.db.count("Pest"))

    def test_a_crop_with_no_pests_offers_none(self):
        with patch.object(crop_catalog, "pests_for_crop", return_value=[]):
            b = B.fetch_creator_bootstrap(crop="Rose")
        self.assertEqual(b["pest_catalog"], [])

    def test_a_rose_only_user_cannot_bootstrap_avocado(self):
        if not frappe.db.exists("Employee", {"user_id": F.PETER}):
            self.skipTest("Peter Kamuren has no Employee record on this site")
        frappe.set_user(F.PETER)
        with self.assertRaises(frappe.PermissionError):
            B.fetch_creator_bootstrap(crop="Avocado")


class TestDiagnoseAndValidation(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.gh = F.rose_greenhouse()

    def tearDown(self):
        crop_scope.clear_cache()
        frappe.db.rollback()

    def test_diagnose_takes_the_crop_from_the_greenhouse(self):
        F.insert_entry(greenhouse=self.gh, crop="Rose", date=FROM,
                       pests=["Thrips", AVOCADO_PEST], diseases=[AVOCADO_DISEASE])
        F.insert_entry(greenhouse=self.gh, crop=None, date=FROM, pests=["Aphids"])
        # The client's crop is ignored when the greenhouse names one.
        out = DA.application_plan_diagnose(greenhouse=self.gh, from_date=FROM, to_date=TO,
                                           crop="Avocado", force="1")
        self.assertEqual(out["targets"], ["Aphids", "Thrips"])
        self.assertEqual(out["filterOpts"]["pests"], ["Aphids", "Thrips"])

    def test_preventive_rejects_an_off_crop_target(self):
        with self.assertRaises(frappe.ValidationError) as cm:
            validate_targets_in_scope("Preventive", [AVOCADO_DISEASE], greenhouse=self.gh, crop="Rose")
        self.assertIn("Rose", str(cm.exception))
        validate_targets_in_scope("Preventive", ["Thrips"], greenhouse=self.gh, crop="Rose")

    def test_curative_needs_observed_and_on_crop(self):
        F.insert_entry(greenhouse=self.gh, crop="Rose", date=today(), pests=["Thrips", AVOCADO_PEST])
        validate_targets_in_scope("Curative", ["Thrips"], greenhouse=self.gh, crop="Rose")
        with self.assertRaises(frappe.ValidationError) as cm:
            validate_targets_in_scope("Curative", [AVOCADO_PEST], greenhouse=self.gh, crop="Rose")
        self.assertIn("Rose", str(cm.exception))

    def test_no_crop_keeps_the_catalog_check(self):
        validate_targets_in_scope("Preventive", [AVOCADO_DISEASE], greenhouse="Nowhere", crop=None)

    def test_saving_a_draft_uses_the_greenhouse_crop(self):
        payload = {
            "custom_classification": "Preventive",
            "custom_preventive_reason": "Routine cover ahead of the long rains.",
            "custom_targets": [AVOCADO_DISEASE],
            "custom_greenhouse": self.gh,
            "_skip_bom_validation": 1,
            "chemicals": [{"item_code": "X", "application_rate": 1}],
            "custom_water_volume": 100,
        }
        with self.assertRaises(frappe.ValidationError) as cm:
            D._validate_payload(payload, {})
        self.assertIn("Rose", str(cm.exception))
```

- [ ] **Step 2: Run it and watch it fail**

DB-RUN `test_crop_scoped_spray_plan`
Expected: bootstrap tests error `TypeError: fetch_creator_bootstrap() got an unexpected keyword argument 'crop'`; diagnose test fails (`['Aphids', 'Fruit fly (Ceratitis)', 'Thrips']` or crop-less row missing); validation tests error `TypeError: … unexpected keyword argument 'crop'`; draft test fails (`ValidationError not raised` — "Avocado Scab" is in the Plant Disease catalog).

- [ ] **Step 3: `bootstrap.py`**

Add after `import frappe`: `from upande_scp.serverscripts.common import crop_catalog, crop_scope`.

Replace the head of `fetch_creator_bootstrap` (decorator through `return _empty_bootstrap()`) with:

```python
@frappe.whitelist()
def fetch_creator_bootstrap(crop: str | None = None) -> dict:
    """Everything the creator page needs, for one crop when `crop` is given.

    With a crop, farms are the user's creator farms ∩ the crop's farms the user
    may see (spec D3), and greenhouses, blocks, kits, teams, tank mixes and farm
    stores follow those farms; the target catalogs are the crop's Pest/Disease
    Filter rows (D2). Without a crop: today's behaviour, for callers not yet
    passing one.
    """
    user = frappe.session.user
    crop = crop_catalog.resolve_crop(crop)
    scope = _resolve_user_scope(user)
    if crop:
        scope = _narrow_to_crop(scope, crop, user)

    if not scope["farms"]:
        return _empty_bootstrap()
```

After `tank_mixes = [t for t in tank_mixes if t.name not in skip]` add:

```python
    if crop:
        # A mix pinned to a farm outside this crop's farms is not offered; the
        # unpinned majority (2,512 of 2,559 on kaitet) stays available.
        farm_set = set(farms)
        tank_mixes = [t for t in tank_mixes if not t.get("custom_farm") or t.get("custom_farm") in farm_set]
```

Replace the `pest_catalog = …` / `disease_catalog = …` block (lines 141-145) with:

```python
    if crop:
        # The crop's own lists — empty stays empty, never the whole catalog.
        pest_catalog = [{"name": n} for n in sorted(crop_catalog.pests_for_crop(crop))]
        disease_catalog = [{"name": n} for n in sorted(crop_catalog.diseases_for_crop(crop))]
    else:
        pest_catalog = frappe.get_all("Pest", fields=["name"], order_by="name") \
            if frappe.db.table_exists("Pest") else []
        # Disease catalog is `Plant Disease`, not `Disease`.
        disease_catalog = frappe.get_all("Plant Disease", fields=["name"], order_by="name") \
            if frappe.db.table_exists("Plant Disease") else []
```

Replace the `farm_store_rows = frappe.get_all("Farm", …)` call with:

```python
    farm_store_rows = frappe.get_all(
        "Farm",
        filters={"name": ["in", farms]} if crop else None,
        fields=["name", "custom_chemical_store", "custom_fertilizer_store"],
    )
```

Add after `_empty_bootstrap`:

```python
def _narrow_to_crop(scope: dict, crop: str, user: str) -> dict:
    """Creator farms ∩ `crop_scope.scoped_farms(crop, user)`; warehouses follow."""
    allowed = crop_scope.scoped_farms(crop, user)
    if allowed is None:
        return scope
    farms = [f for f in scope["farms"] if f in allowed]
    keep = set(farms)
    warehouses = [w for w in scope["warehouses"] if w.get("custom_farm") in keep]
    return {
        "farms": farms,
        "warehouses": warehouses,
        "greenhouses": [w for w in warehouses if (w.get("warehouse_type") or "") == "Greenhouse"],
    }
```

(`scope["farms"]` order is kept; `test_avocado…` expects exactly `["Lokitela"]`.)

- [ ] **Step 4: `_application_plan.py`** — add `from upande_scp.serverscripts.common import crop_catalog`. In `application_plan_diagnose`, replace the `row_filters = {...}` dict and the `cached_aggregate("application_plan_rows", …)` call with:

```python
    # The greenhouse decides the crop (spec D6); the request's crop is only a
    # fallback for a greenhouse whose farm is on no crop (today's behaviour).
    crop = crop_catalog.crop_for_greenhouse(greenhouse) or (args.get("crop") or "").strip()
    row_filters = {
        "greenhouse": greenhouse,
        "from_date":  args.get("from_date", ""),
        "to_date":    args.get("to_date", ""),
        "crop":       crop,
    }
    job_id = (args.get("job_id") or "").strip()
    # _v2: rows cached under the old rules (crop_scouted only, every pest)
    # must not be served after deploy.
    rows = cached_aggregate(
        "application_plan_rows_v2",
        row_filters,
        lambda: _load_rows(row_filters, job_id),
        force=force,
    )
```

In `_query_kind`, replace

```python
    crop_clause = ""
    if filters["crop"]:
        crop_clause = "AND se.crop_scouted = %(crop)s"
        params["crop"] = filters["crop"]
```

with

```python
    crop_clause = ""
    if filters["crop"]:
        # D5 (crop-less rows in this greenhouse count) + D4 (off-crop targets drop).
        crop_clause = (
            f"AND {crop_catalog.entry_crop_condition('se')} "
            f"AND {crop_catalog.obs_crop_condition(kind, 'c.' + col)}"
        )
        params.update(crop_catalog.crop_sql_params(filters["crop"]))
```

- [ ] **Step 5: `validation.py`** — add `from upande_scp.serverscripts.common import crop_catalog` after `import frappe`, and replace `validate_targets_in_scope` (signature through the end of the `else:` branch) with:

```python
def validate_targets_in_scope(
    classification: str,
    targets: Iterable[str],
    *,
    greenhouse: str | None = None,
    days: int = 60,
    crop: str | None = None,
) -> None:
    """Targets must belong to the plan's crop (spec D6), and Curative targets
    must also have been observed in the greenhouse. With no crop (a greenhouse
    whose farm is on no crop) the old catalog check applies."""
    targets = [t for t in (targets or []) if t]
    if not targets:
        frappe.throw("At least one target is required.")

    if crop:
        allowed = set(crop_catalog.targets_for_crop(crop))
        off_crop = [t for t in targets if t not in allowed]
        if off_crop:
            frappe.throw(
                f"These targets are not {crop} pests or diseases: {', '.join(off_crop)}.",
                title="Target not for this crop",
            )

    if classification == "Curative":
        # Every target must appear in a Scouting Entry for this greenhouse in
        # the last `days` days. Greenhouse name is the warehouse name; the
        # parent Scouting Entry's `zone` field is a string that starts with
        # the greenhouse name (e.g. "Kaptumbo GH 12 - Bed 5").
        cutoff = add_days(now_datetime(), -days)
        observed_pests = set(_observed_targets(greenhouse, cutoff, kind="pest"))
        observed_diseases = set(_observed_targets(greenhouse, cutoff, kind="disease"))
        observed = observed_pests | observed_diseases
        unknown = [t for t in targets if t not in observed]
        if unknown:
            frappe.throw(
                f"These targets have not been observed in {greenhouse} in the last "
                f"{days} days: {', '.join(unknown)}.",
                title="Targets not observed",
            )
    elif not crop:
        # Preventive with no crop: each target must exist in the Pest or Plant Disease catalog.
        for t in targets:
            if not (frappe.db.exists("Pest", t) or frappe.db.exists("Plant Disease", t)):
                frappe.throw(
                    f"Target '{t}' is not in the Pest or Plant Disease catalog.",
                    title="Unknown target",
                )
```

- [ ] **Step 6: `drafts.py`** — change line 9 to `from ..common import crop_catalog, crop_protection` and in `_validate_payload` replace the `validate_targets_in_scope(...)` call with:

```python
        validate_targets_in_scope(
            classification,
            payload.get("custom_targets") or [],
            greenhouse=payload.get("custom_greenhouse"),
            crop=crop_catalog.crop_for_greenhouse(payload.get("custom_greenhouse")),
        )
```

- [ ] **Step 7: Run the tests**

DB-RUN `test_crop_scoped_spray_plan` → `Ran 10 tests … OK` (Peter test may skip).
DB-RUN `test_spray_compliance_api` → `OK`.
DB-RUN `test_crop_scoped_aggregates` → `OK`.

- [ ] **Step 8: Commit**

```bash
git add upande_scp/serverscripts/spray_plan_creator/bootstrap.py upande_scp/serverscripts/dashboard_aggregates/_application_plan.py \
  upande_scp/serverscripts/spray_plan_creator/validation.py upande_scp/serverscripts/spray_plan_creator/drafts.py \
  upande_scp/serverscripts/tests/test_crop_scoped_spray_plan.py
git commit -m "feat(scp): spray plans offer and accept only the greenhouse crop's farms and targets"
```

---

### Task 6: Thresholds server — crop resolved, rows of another crop refused

**Files:**
- Create: `upande_scp/serverscripts/tests/test_thresholds_crop_guard.py`
- Modify: `upande_scp/serverscripts/store/thresholds_api.py` (imports :14-16; `get_thresholds` :52-63; `save_thresholds` :170-183)

**Interfaces:**
- Consumes: `crop_catalog.resolve_crop`.
- Produces: `get_thresholds(crop) -> dict` (`crop` canonical in the payload; unknown/not-allowed → `PermissionError`); `save_thresholds(crop, payload) -> dict` raises `frappe.ValidationError` before any write when a row is not the crop's; new private `_assert_rows_belong(crop: str, payload: dict) -> None`.

- [ ] **Step 1: Write the failing test** — `upande_scp/serverscripts/tests/test_thresholds_crop_guard.py`

```python
"""Settings → Thresholds is crop-keyed end to end. DB test — the commit at the
bottom of save_thresholds is patched out, so nothing here can persist."""

import unittest
from unittest.mock import patch

import frappe

from upande_scp.serverscripts.common import crop_catalog, crop_scope
from upande_scp.serverscripts.store import thresholds_api as T


class TestThresholdsCropGuard(unittest.TestCase):
    def setUp(self):
        crop_scope.clear_cache()
        crop_catalog.invalidate_catalog()
        self.avo_row = frappe.db.get_value("Pest Filter", {"crop_scouted": "Avocado"}, "name")
        self.rose_row = frappe.db.get_value("Pest Filter", {"crop_scouted": "Rose"}, "name")
        # save_thresholds commits at the end. Before the guard exists (the
        # red run) a save would reach it, so the commit is neutralised for
        # every test and tearDown's rollback always undoes the writes.
        self._no_commit = patch.object(frappe.db, "commit")
        self._no_commit.start()

    def tearDown(self):
        self._no_commit.stop()
        frappe.db.rollback()

    def test_get_thresholds_canonicalises_the_crop(self):
        out = T.get_thresholds("rose")
        self.assertEqual(out["crop"], "Rose")
        rose = set(crop_catalog.pests_for_crop("Rose"))
        self.assertTrue(out["pests"])
        self.assertTrue(all(p["pest"] in rose for p in out["pests"]))

    def test_an_unknown_crop_is_refused(self):
        with self.assertRaises(frappe.PermissionError):
            T.get_thresholds("Mango")

    def test_saving_another_crops_row_is_refused(self):
        before = frappe.db.get_value("Pest Filter", self.avo_row, "high_threshold")
        payload = {"pests": [{"row": self.avo_row, "low": 1, "moderate": 2, "high": 99, "stages": []}],
                   "diseases": []}
        with self.assertRaises(frappe.ValidationError):
            T.save_thresholds("Rose", payload)
        self.assertEqual(frappe.db.get_value("Pest Filter", self.avo_row, "high_threshold"), before)

    def test_a_stage_row_must_sit_under_its_row(self):
        stage = frappe.db.get_value("Pests Stages", {"parenttype": "Pest Filter", "parent": self.avo_row}, "name")
        if not stage:
            self.skipTest("the Avocado pest row has no stage rows on this site")
        payload = {"pests": [{"row": self.rose_row, "low": 0, "moderate": 0, "high": 0,
                              "stages": [{"row": stage, "low": 1, "moderate": 2, "high": 3}]}],
                   "diseases": []}
        with self.assertRaises(frappe.ValidationError):
            T.save_thresholds("Rose", payload)
```

- [ ] **Step 2: Run it and watch it fail**

DB-RUN `test_thresholds_crop_guard`
Expected: `test_get_thresholds_canonicalises_the_crop` fails (`'rose' != 'Rose'`), `test_an_unknown_crop_is_refused` fails (`PermissionError not raised`), the two save tests fail (`ValidationError not raised`). The red run writes nothing permanent: `frappe.db.commit` is patched out in `setUp` and `tearDown` rolls back. Verify with `bench --site kaitet.local mariadb -e "select name, high_threshold from \`tabPest Filter\` where crop_scouted='Avocado' limit 3"` before and after if in doubt.

- [ ] **Step 3: `thresholds_api.py`**

Add `from upande_scp.serverscripts.common import crop_catalog` after `import frappe`.

In `get_thresholds`, replace

```python
    crop = (crop or "").strip()
    if not crop:
        return {"crop": "", "pests": [], "diseases": []}
```

with

```python
    crop = crop_catalog.resolve_crop(crop)
    if not crop:
        return {"crop": "", "pests": [], "diseases": []}
```

In `save_thresholds`, replace

```python
    crop = (crop or "").strip()
    if not crop:
        frappe.throw("Missing crop", frappe.ValidationError)
    if isinstance(payload, str):
        payload = json.loads(payload)
```

with

```python
    crop = crop_catalog.resolve_crop(crop)
    if not crop:
        frappe.throw("Missing crop", frappe.ValidationError)
    if isinstance(payload, str):
        payload = json.loads(payload)
    _assert_rows_belong(crop, payload)
```

Add before `save_thresholds`:

```python
_KINDS = (
    ("pests", "Pest Filter", "Pests Stages"),
    ("diseases", "Disease Filter", "Disease Stages"),
)


def _assert_rows_belong(crop: str, payload: dict) -> None:
    """Refuse the whole save if any row is not `crop`'s (spec §5).

    Checked before the first write: `save_thresholds` commits at the end, so a
    half-applied payload would be permanent.
    """
    for key, doctype, child in _KINDS:
        rows = [r for r in (payload.get(key) or []) if r.get("row")]
        if not rows:
            continue
        owners = dict(frappe.db.sql(
            f"select name, crop_scouted from `tab{doctype}` where name in %(n)s",
            {"n": [r["row"] for r in rows]},
        ))
        wrong = [r["row"] for r in rows if owners.get(r["row"]) != crop]
        if wrong:
            frappe.throw(f"{doctype} rows {', '.join(wrong)} are not {crop} rows.", frappe.ValidationError)
        for r in rows:
            stages = [s["row"] for s in (r.get("stages") or []) if s.get("row")]
            if not stages:
                continue
            parents = dict(frappe.db.sql(
                f"select name, parent from `tab{child}` where name in %(n)s and parenttype = %(pt)s",
                {"n": stages, "pt": doctype},
            ))
            stray = [s for s in stages if parents.get(s) != r["row"]]
            if stray:
                frappe.throw(f"{child} rows {', '.join(stray)} do not belong to {r['row']}.", frappe.ValidationError)
```

- [ ] **Step 4: Run the tests**

DB-RUN `test_thresholds_crop_guard` → `Ran 4 tests … OK` (stage test may skip).

- [ ] **Step 5: Commit**

```bash
git add upande_scp/serverscripts/store/thresholds_api.py upande_scp/serverscripts/tests/test_thresholds_crop_guard.py
git commit -m "fix(scp): thresholds resolve the route crop and refuse rows that belong to another crop"
```

---

### Task 7: Frontend farm lists — `useCropFarms`, map headers, Heatmaps, TrapsMap, Rose scoped fetch

**Files:**
- Create: `frontend/src/hooks/use-crop-farms.ts`, `frontend/src/hooks/__tests__/use-crop-farms.test.ts`, `frontend/src/hooks/__tests__/use-scouting-crop.test.ts`, `frontend/src/pages/maps/__tests__/MapHeader.crop.test.tsx`
- Modify: `frontend/src/pages/maps/MapHeader.tsx` (imports :13-17; props :36-38, :59; state/effect/farmList :62-86; crop Select :109-127)
- Modify: `frontend/src/pages/maps/RangeHeader.tsx` (imports :22-26; props :81, :96; state/effect/farmList :101-126; crop Select :135-153)
- Modify: `frontend/src/pages/maps/SingleDayHeader.tsx` (imports :22-26; props :43-44, :54; state/effect/farmList :57-82; crop block :106-128)
- Modify: `frontend/src/pages/TrapsMap.tsx` (:17, :247-267, `showCrop={false}` :505), `RoseScouting.tsx:536`, `Observations.tsx:390`, `Spraying.tsx:399`, `avocado/AvocadoTreeMap.tsx:479` (drop `showCrop={false}`)
- Modify: `frontend/src/pages/Heatmaps.tsx` (imports :51-56; :201-205; :281-300; :335; Select :466-479)
- Modify: `frontend/src/hooks/use-scouting.ts:121-124`

**Interfaces:**
- Consumes: `fetchFarmsAndWarehousesResult(crop?: string): Promise<FarmsResult>` (`frontend/src/lib/scouting-api.ts:239`), server `get_farms_and_warehouses(crop)` (Task 4).
- Produces: `useCropFarms(crop: string): { farms: Record<string, string[]>; error?: "stale-session" | "failed"; loading: boolean }` in `@/hooks/use-crop-farms`. `MapHeader` / `RangeHeader` / `SingleDayHeader` lose the `showCrop` prop.

- [ ] **Step 1: Write the failing tests**

`frontend/src/hooks/__tests__/use-crop-farms.test.ts`:

```ts
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchFarmsAndWarehousesResult = vi.fn();
vi.mock("@/lib/scouting-api", () => ({
  fetchFarmsAndWarehousesResult: (...a: unknown[]) => fetchFarmsAndWarehousesResult(...a),
}));

import { useCropFarms } from "@/hooks/use-crop-farms";

beforeEach(() => {
  fetchFarmsAndWarehousesResult.mockReset().mockImplementation(async (crop?: string) => ({
    farms: crop === "Avocado" ? { Lokitela: ["AIRSTRIP BLK 1 - KL"] } : { Karen: ["Karen GH 01 - KR"] },
  }));
});

describe("useCropFarms", () => {
  it("asks the server for the route crop's farms", async () => {
    const { result } = renderHook(() => useCropFarms("Avocado"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchFarmsAndWarehousesResult).toHaveBeenCalledWith("Avocado");
    expect(Object.keys(result.current.farms)).toEqual(["Lokitela"]);
  });

  it("refetches when the crop changes", async () => {
    const { result, rerender } = renderHook(({ c }) => useCropFarms(c), { initialProps: { c: "Avocado" } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ c: "Rose" });
    await waitFor(() => expect(Object.keys(result.current.farms)).toEqual(["Karen"]));
    expect(fetchFarmsAndWarehousesResult).toHaveBeenLastCalledWith("Rose");
  });
});
```

`frontend/src/hooks/__tests__/use-scouting-crop.test.ts`:

```ts
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMissingWeeks = vi.fn();
const refreshRecentWeeks = vi.fn();
vi.mock("@/lib/scouting-sync", () => ({
  getMissingWeeks: (...a: unknown[]) => getMissingWeeks(...a),
  hydrateRange: vi.fn(),
  invalidateMonth: vi.fn(),
  primeAndDelta: vi.fn().mockResolvedValue(undefined),
  readEntries: vi.fn().mockResolvedValue([]),
  refreshRecentWeeks: (...a: unknown[]) => refreshRecentWeeks(...a),
}));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));

import { useScouting } from "@/hooks/use-scouting";

beforeEach(() => {
  getMissingWeeks.mockReset().mockResolvedValue([]);
  refreshRecentWeeks.mockReset().mockResolvedValue(false);
});

describe("useScouting crop scoping", () => {
  it("fetches the Rose slice from the server instead of the all-crop one", async () => {
    renderHook(() => useScouting({ from: "2026-09-01", to: "2026-09-07", crop: "Rose" }));
    await waitFor(() => expect(getMissingWeeks).toHaveBeenCalled());
    expect(getMissingWeeks).toHaveBeenCalledWith("2026-09-01", "2026-09-07", "Rose", undefined);
  });

  it("keeps the all-crop path when no crop is given", async () => {
    renderHook(() => useScouting({ from: "2026-09-01", to: "2026-09-07" }));
    await waitFor(() => expect(getMissingWeeks).toHaveBeenCalled());
    expect(getMissingWeeks).toHaveBeenCalledWith("2026-09-01", "2026-09-07", undefined, undefined);
  });
});
```

`frontend/src/pages/maps/__tests__/MapHeader.crop.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchFarmsAndWarehousesResult = vi.fn();
const fetchCrops = vi.fn();
vi.mock("@/lib/scouting-api", () => ({
  fetchFarmsAndWarehousesResult: (...a: unknown[]) => fetchFarmsAndWarehousesResult(...a),
  fetchFarmsAndWarehouses: vi.fn(),
  fetchCrops: (...a: unknown[]) => fetchCrops(...a),
  DEFAULT_CROP: "Rose",
}));

import { ALL, MapHeader } from "@/pages/maps/MapHeader";

beforeEach(() => {
  fetchCrops.mockReset().mockResolvedValue([]);
  fetchFarmsAndWarehousesResult.mockReset().mockResolvedValue({
    farms: { Lokitela: ["AIRSTRIP BLK 1 - KL"] },
  });
});

describe("MapHeader on the avocado jobsheet", () => {
  it("lists the crop's farms from the server and has no crop picker", async () => {
    const onChange = vi.fn();
    render(
      <MapHeader
        title="Jobsheet"
        subtitle=""
        value={{ crop: "Avocado", farm: ALL, greenhouse: ALL, from: "2026-01-01", to: "2026-09-01" }}
        onChange={onChange}
        showGreenhouse={false}
      />,
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ farm: "Lokitela" })),
    );
    expect(fetchFarmsAndWarehousesResult).toHaveBeenCalledWith("Avocado");
    expect(fetchCrops).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Crop")).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

`cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/hooks/__tests__/use-crop-farms.test.ts src/hooks/__tests__/use-scouting-crop.test.ts src/pages/maps/__tests__/MapHeader.crop.test.tsx`
Expected: `use-crop-farms` fails to resolve `@/hooks/use-crop-farms`; the Rose test fails (`getMissingWeeks` called with `undefined` for the crop); MapHeader fails (`fetchCrops` called; `fetchFarmsAndWarehousesResult` not called).

- [ ] **Step 3: Create `frontend/src/hooks/use-crop-farms.ts`**

```ts
import { useEffect, useState } from "react";
import { fetchFarmsAndWarehousesResult, type FarmsResult } from "@/lib/scouting-api";

export type CropFarms = FarmsResult & { loading: boolean };

/** The route crop's farm → warehouses map, narrowed on the server (spec D3).
 *  The server also applies the user's own scope, so nothing outside the crop
 *  ever reaches the page. An empty crop keeps the old unscoped list. */
export function useCropFarms(crop: string): CropFarms {
  const [state, setState] = useState<CropFarms>({ farms: {}, loading: true });
  useEffect(() => {
    let cancelled = false;
    setState({ farms: {}, loading: true });
    fetchFarmsAndWarehousesResult(crop || undefined).then((r) => {
      if (!cancelled) setState({ ...r, loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, [crop]);
  return state;
}
```

- [ ] **Step 4: `MapHeader.tsx`**

- Replace lines 13-17 (`import { fetchCrops, fetchFarmsAndWarehouses, DEFAULT_CROP } from "@/lib/scouting-api";`) with `import { useCropFarms } from "@/hooks/use-crop-farms";`.
- Delete the `showCrop` doc comment and prop (lines 36-38) from `MapHeaderProps`, and `showCrop = true,` (line 59) from the destructuring.
- Replace lines 62-86 (the `crops` state, `farms` state, the `useEffect` calling `fetchCrops`/`fetchFarmsAndWarehouses`, and the `farmList` IIFE) with:

```tsx
  // Farms for the route crop only, narrowed on the server (spec D3).
  const { farms } = useCropFarms(value.crop);
  const farmList = Object.keys(farms);
```

- Delete the whole `{showCrop && ( <Select … aria-label="Crop" …> … </Select> )}` block (lines 109-127).

- [ ] **Step 5: `RangeHeader.tsx`** — same four edits: imports 22-26 → `import { useCropFarms } from "@/hooks/use-crop-farms";`; delete `showCrop?: boolean;` (81) and `showCrop = true,` (96); replace 101-126 with the same three-line `useCropFarms` block; delete the `{showCrop && ( … )}` block (135-153).

- [ ] **Step 6: `SingleDayHeader.tsx`** — same: imports 22-26 → `useCropFarms`; delete the `showCrop` doc comment + prop (43-44) and `showCrop = true,` (54); replace 57-82 with the `useCropFarms` block; delete the `{showCrop && ( <div …><Label>Crop</Label> … </div> )}` block (106-128).

- [ ] **Step 7: Callers** — delete the line `showCrop={false}` in `TrapsMap.tsx` (~505), `RoseScouting.tsx` (~536), `Observations.tsx` (~390), `Spraying.tsx` (~399), `avocado/AvocadoTreeMap.tsx` (~479). (`avocado/AvocadoHeatMap.tsx` ~468 is edited in Task 9 with the rest of that file; delete its `showCrop={false}` line now too so the typecheck passes.)

`TrapsMap.tsx`: change `fetchFarmsAndWarehouses()` (line ~250) to `fetchFarmsAndWarehouses(filters.crop)` and the effect's dependency list `}, []);` (line ~267) to `}, [filters.crop]);`.

- [ ] **Step 8: `Heatmaps.tsx`**

- Imports 51-56 become:

```tsx
import {
  fetchBedsAndZones,
  DEFAULT_CROP,
} from "@/lib/scouting-api";
import { useCropFarms } from "@/hooks/use-crop-farms";
```

- Line 201: `const [crop, setCrop] = useState<string>(initialCrop ?? DEFAULT_CROP);` → `const crop = initialCrop ?? DEFAULT_CROP;`
- Delete the `crops` state (203-205).
- Replace the bootstrap effect (281-300: `fetchCrops()…` and `fetchFarmsAndWarehousesResult()…`) with:

```tsx
  // Farm → greenhouse map for the tree, for the route crop only (server-side).
  const { farms: cropFarms, error: cropFarmsError } = useCropFarms(crop);
  useEffect(() => {
    const ghToFarm: Record<string, string> = {};
    Object.entries(cropFarms).forEach(([farm, ghs]) => {
      (ghs || []).forEach((g) => (ghToFarm[g] = farm));
    });
    setFarmsByGh(ghToFarm);
    setFarmsError(cropFarmsError ?? null);
  }, [cropFarms, cropFarmsError]);
```

- Line 335: `crop: crop === DEFAULT_CROP ? "" : crop,` → `crop,`
- Delete the `{!initialCrop && ( <Select value={crop} onValueChange={setCrop}> … </Select> )}` block (466-479).

- [ ] **Step 9: `use-scouting.ts`** — replace lines 121-124:

```ts
    // Every crop is fetched as its own server-side slice — Rose included — so
    // the server applies the crop's farm and pest/disease scope (spec D4/D5).
    // No crop keeps the shared all-crop path.
    const scopedCrop = crop || undefined;
```

- [ ] **Step 10: Run tests, typecheck**

`cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/hooks/__tests__/use-crop-farms.test.ts src/hooks/__tests__/use-scouting-crop.test.ts src/pages/maps/__tests__/MapHeader.crop.test.tsx` → `3 passed (5 tests)`.
`npx vitest run` → all green.
`npx tsc --noEmit -p tsconfig.app.json` → no output, exit 0.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/hooks/use-crop-farms.ts frontend/src/hooks/use-scouting.ts \
  frontend/src/hooks/__tests__/use-crop-farms.test.ts frontend/src/hooks/__tests__/use-scouting-crop.test.ts \
  frontend/src/pages/maps/MapHeader.tsx frontend/src/pages/maps/RangeHeader.tsx frontend/src/pages/maps/SingleDayHeader.tsx \
  frontend/src/pages/maps/__tests__/MapHeader.crop.test.tsx frontend/src/pages/Heatmaps.tsx frontend/src/pages/TrapsMap.tsx \
  frontend/src/pages/RoseScouting.tsx frontend/src/pages/Observations.tsx frontend/src/pages/Spraying.tsx \
  frontend/src/pages/avocado/AvocadoTreeMap.tsx frontend/src/pages/avocado/AvocadoHeatMap.tsx
git commit -m "feat(scp-ui): map headers and heatmaps list the route crop's farms from the server and lose their crop pickers"
```

---

### Task 8: Dashboard and Trends — route crop always sent, crop selects removed

**Files:**
- Create: `frontend/src/pages/__tests__/Dashboard.crop.test.tsx`, `frontend/src/pages/__tests__/Trends.crop.test.tsx`
- Modify: `frontend/src/pages/Dashboard.tsx` (imports :3-6; :39-68; :88; Select :138-151)
- Modify: `frontend/src/pages/Trends.tsx` (import :4; :48-69; :77; Select :191-204)

**Interfaces:**
- Consumes: `useCropFarms(crop)` (Task 7); aggregate endpoints that resolve the crop (Task 2).
- Produces: Dashboard/Trends send `crop: <route crop>` on every aggregate call — `"Rose"` is no longer sent as `""`.

- [ ] **Step 1: Write the failing tests**

`frontend/src/pages/__tests__/Dashboard.crop.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useDashboardAggregate = vi.fn();
const fetchFarmsAndWarehousesResult = vi.fn();
const fetchCrops = vi.fn();

vi.mock("@/hooks/use-dashboard-aggregate", () => ({
  useDashboardAggregate: (...a: unknown[]) => useDashboardAggregate(...a),
}));
vi.mock("@/lib/scouting-api", () => ({
  fetchFarmsAndWarehousesResult: (...a: unknown[]) => fetchFarmsAndWarehousesResult(...a),
  fetchFarmsAndWarehouses: vi.fn(),
  fetchCrops: (...a: unknown[]) => fetchCrops(...a),
  fetchScoutLookup: vi.fn().mockResolvedValue({}),
  fetchZonesByGreenhouse: vi.fn().mockResolvedValue({}),
  DEFAULT_CROP: "Rose",
}));
vi.mock("@/pages/dashboard/OverviewTab", () => ({ OverviewTab: () => null }));
vi.mock("@/pages/dashboard/PestsTab", () => ({ PestsTab: () => null }));
vi.mock("@/pages/dashboard/DiseasesTab", () => ({ DiseasesTab: () => null }));
vi.mock("@/pages/dashboard/TrapsTab", () => ({ TrapsTab: () => null }));
vi.mock("@/pages/dashboard/FcmTab", () => ({ FcmTab: () => null }));
vi.mock("@/components/LoadingOverlay", () => ({ LoadingOverlay: () => null }));

import { Dashboard } from "@/pages/Dashboard";

beforeEach(() => {
  useDashboardAggregate.mockReset().mockReturnValue({
    data: null, loading: false, error: null, progress: null, reload: vi.fn(),
  });
  fetchCrops.mockReset().mockResolvedValue([]);
  fetchFarmsAndWarehousesResult.mockReset().mockResolvedValue({ farms: { Lokitela: ["AIRSTRIP BLK 1 - KL"] } });
});

describe("Dashboard follows the route crop", () => {
  it("sends the route crop and asks for that crop's farms", async () => {
    render(<Dashboard initialCrop="Avocado" />);
    await waitFor(() => expect(fetchFarmsAndWarehousesResult).toHaveBeenCalledWith("Avocado"));
    const overview = useDashboardAggregate.mock.calls.find((c) => c[0] === "overview");
    expect(overview?.[1]).toMatchObject({ crop: "Avocado" });
    expect(fetchCrops).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Crop")).toBeNull();
  });

  it("sends Rose as Rose, not as the old empty string", () => {
    render(<Dashboard initialCrop="Rose" />);
    const overview = useDashboardAggregate.mock.calls.find((c) => c[0] === "overview");
    expect(overview?.[1]).toMatchObject({ crop: "Rose" });
  });
});
```

`frontend/src/pages/__tests__/Trends.crop.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useDashboardAggregate = vi.fn();
const fetchCrops = vi.fn();

vi.mock("@/hooks/use-dashboard-aggregate", () => ({
  useDashboardAggregate: (...a: unknown[]) => useDashboardAggregate(...a),
}));
vi.mock("@/lib/scouting-api", () => ({
  fetchCrops: (...a: unknown[]) => fetchCrops(...a),
  DEFAULT_CROP: "Rose",
}));
vi.mock("@/lib/thresholds-api", () => ({
  getThresholds: vi.fn().mockResolvedValue({ crop: "Rose", pests: [], diseases: [] }),
}));
vi.mock("@/pages/trends/TristateTree", () => ({ TristateTree: () => null }));
vi.mock("@/pages/trends/ChartPanel", () => ({ ChartPanel: () => null }));
vi.mock("@/components/LoadingOverlay", () => ({ LoadingOverlay: () => null }));

import { Trends } from "@/pages/Trends";

beforeEach(() => {
  useDashboardAggregate.mockReset().mockReturnValue({
    data: null, loading: false, error: null, progress: null, reload: vi.fn(),
  });
  fetchCrops.mockReset().mockResolvedValue([]);
});

describe("Trends follows the route crop", () => {
  it.each(["Rose", "Coffee"])("asks for %s trends and shows no crop picker", (crop) => {
    render(<Trends initialCrop={crop} />);
    expect(useDashboardAggregate).toHaveBeenCalledWith(
      "trends", expect.objectContaining({ crop }), true,
    );
    expect(fetchCrops).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Crop")).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

`cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/pages/__tests__/Dashboard.crop.test.tsx src/pages/__tests__/Trends.crop.test.tsx`
Expected: Dashboard fails (`fetchFarmsAndWarehousesResult` never called — it uses `fetchFarmsAndWarehouses()`; Rose case gets `crop: ""`); Trends fails for Rose (`crop: ""`) and on `fetchCrops` having been called.

- [ ] **Step 3: `Dashboard.tsx`**

- Imports 3-6 become:

```tsx
import {
  fetchScoutLookup, fetchZonesByGreenhouse, DEFAULT_CROP,
} from "@/lib/scouting-api";
import { useCropFarms } from "@/hooks/use-crop-farms";
```

- Replace lines 39-68 (from `const [crop, setCrop] = …` through the `})();` that ends the `farmList` IIFE) with:

```tsx
  // The crop is the route's (spec D1); the page carries no crop picker.
  const crop = initialCrop ?? DEFAULT_CROP;
  const [farm, setFarm] = useState<string>(ALL_FARMS);
  const [greenhouse, setGreenhouse] = useState<string>(ALL_GH);
  const [{ from, to }, setRange] = useState(defaultRange);
  const { farms } = useCropFarms(crop);
  const [scoutLookup, setScoutLookup] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchScoutLookup().then(setScoutLookup);
    void fetchZonesByGreenhouse();
  }, []);

  // Already the crop's farms — narrowed on the server.
  const farmList = Object.keys(farms);
```

- Line 88: `crop: crop === DEFAULT_CROP ? "" : crop,` → `crop,`
- Delete the `{!initialCrop && ( <Select value={crop} onValueChange={setCrop}> … </Select> )}` block (138-151).

- [ ] **Step 4: `Trends.tsx`**

- Line 4: `import { fetchCrops, DEFAULT_CROP } from "@/lib/scouting-api";` → `import { DEFAULT_CROP } from "@/lib/scouting-api";`
- Replace lines 48-69 (`const [crop, setCrop] = …` through the `fetchCrops` effect) with:

```tsx
  // The crop is the route's (spec D1); the page carries no crop picker.
  const crop = initialCrop ?? DEFAULT_CROP;
  const [{ from, to }, setRange] = useState(defaultRange);
  const [stationChecks, setStationChecks] = useState<Set<string>>(new Set());
  const [obsChecks, setObsChecks] = useState<Set<string>>(new Set());
  const [showThresholds, setShowThresholds] = useState(true);
  const [thresholdBundle, setThresholdBundle] =
    useState<ThresholdsBundle | null>(null);
```

- Line 77: `crop: crop === DEFAULT_CROP ? "" : crop,` → `crop,`
- Delete the `{!initialCrop && ( <Select value={crop} onValueChange={setCrop}> … </Select> )}` block (191-204).

- [ ] **Step 5: Run tests, typecheck**

`npx vitest run src/pages/__tests__/Dashboard.crop.test.tsx src/pages/__tests__/Trends.crop.test.tsx` → `2 passed (4 tests)`.
`npx vitest run` → all green. `npx tsc --noEmit -p tsconfig.app.json` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Dashboard.tsx frontend/src/pages/Trends.tsx \
  frontend/src/pages/__tests__/Dashboard.crop.test.tsx frontend/src/pages/__tests__/Trends.crop.test.tsx
git commit -m "feat(scp-ui): dashboard and trends always ask for the route crop and drop their crop pickers"
```

---

### Task 9: Spray plan frontend — route crop to bootstrap, no hard-coded Rose

**Files:**
- Create: `frontend/src/lib/spray-plan-creator-api.test.ts`, `frontend/src/pages/avocado/__tests__/BlockSprayPlan.crop.test.tsx`, `frontend/src/pages/__tests__/ApplicationPlan.crop.test.ts`
- Modify: `frontend/src/lib/spray-plan-creator-api.ts:115-119`
- Modify: `frontend/src/pages/ApplicationPlan.tsx` (:251; :384; :401; :1523; empty-catalog text :2091)
- Modify: `frontend/src/pages/avocado/BlockSprayPlan.tsx` (props :51-63; effect :72-76)
- Modify: `frontend/src/pages/avocado/AvocadoHeatMap.tsx` (:107-114; :684)
- Modify: `frontend/src/App.tsx` (`case "heatmaps"` :227-232; `case "application-plan"` :262)

**Interfaces:**
- Consumes: server `fetch_creator_bootstrap(crop)` (Task 5), diagnose deriving crop from greenhouse (Task 5).
- Produces: `fetchCreatorBootstrap(crop?: string): Promise<CreatorBootstrap>`; `ApplicationPlan({ initialCrop }: { initialCrop?: string })`; `BlockSprayPlan({ block, targets, crop = "Avocado", onDone })`; `AvocadoHeatMap({ initialCrop = "Avocado" })`.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/spray-plan-creator-api.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const call = vi.fn();
vi.mock("./frappe", () => ({ call: (...a: unknown[]) => call(...a) }));

import { fetchCreatorBootstrap } from "./spray-plan-creator-api";

const METHOD = "upande_scp.serverscripts.spray_plan_creator.bootstrap.fetch_creator_bootstrap";

beforeEach(() => call.mockReset().mockResolvedValue({}));

describe("fetchCreatorBootstrap", () => {
  it("sends the route crop", async () => {
    await fetchCreatorBootstrap("Avocado");
    expect(call).toHaveBeenCalledWith(METHOD, { crop: "Avocado" });
  });

  it("sends nothing when there is no crop (old behaviour)", async () => {
    await fetchCreatorBootstrap();
    expect(call).toHaveBeenCalledWith(METHOD, {});
  });
});
```

`frontend/src/pages/avocado/__tests__/BlockSprayPlan.crop.test.tsx`:

```tsx
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchCreatorBootstrap = vi.fn();
vi.mock("@/lib/spray-plan-creator-api", () => ({
  fetchCreatorBootstrap: (...a: unknown[]) => fetchCreatorBootstrap(...a),
  createDraftSprayPlan: vi.fn(),
}));

import { BlockSprayPlan } from "@/pages/avocado/BlockSprayPlan";

const BOOT = {
  scope: { farms: ["Lokitela"], allowed_warehouses: [] },
  greenhouses: [],
  blocks: [{ name: "AIRSTRIP BLK 1 - KL", custom_farm: "Lokitela", latitude: null, longitude: null, cost_center: null, area_ha: 2 }],
  kits: [], spray_teams: [], tank_mixes: [], rate_limits: {},
  pest_catalog: [], disease_catalog: [], cost_centers: [], weather_settings: {},
  irac_window_days: 14, frac_window_days: 21, farm_stores: {},
};

beforeEach(() => fetchCreatorBootstrap.mockReset().mockResolvedValue(BOOT));

describe("BlockSprayPlan", () => {
  it("bootstraps for the crop it is given", async () => {
    render(<BlockSprayPlan block="AIRSTRIP BLK 1 - KL" crop="Coffee" />);
    await waitFor(() => expect(fetchCreatorBootstrap).toHaveBeenCalledWith("Coffee"));
  });

  it("defaults to Avocado", async () => {
    render(<BlockSprayPlan block="AIRSTRIP BLK 1 - KL" />);
    await waitFor(() => expect(fetchCreatorBootstrap).toHaveBeenCalledWith("Avocado"));
  });
});
```

`frontend/src/pages/__tests__/ApplicationPlan.crop.test.ts` (source guard — the page is 2,000+ lines with a dozen data dependencies; rendering it to check two call arguments would test the mocks, not the page):

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("ApplicationPlan crop wiring", () => {
  const page = src("../ApplicationPlan.tsx");
  const app = src("../../App.tsx");

  it("no longer hard-codes Rose for diagnose", () => {
    expect(page).not.toMatch(/crop:\s*"Rose"/);
  });

  it("bootstraps with the route crop on load and after creating a BOM", () => {
    expect(page.match(/fetchCreatorBootstrap\(initialCrop\)/g)?.length).toBe(2);
    expect(page).not.toMatch(/fetchCreatorBootstrap\(\)/);
  });

  it("receives the route crop from the router", () => {
    expect(app).toContain("<ApplicationPlan initialCrop={cropName} />");
    expect(app).toContain("<AvocadoHeatMap initialCrop={cropName} />");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

`cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/lib/spray-plan-creator-api.test.ts src/pages/avocado/__tests__/BlockSprayPlan.crop.test.tsx src/pages/__tests__/ApplicationPlan.crop.test.ts`
Expected: api test fails (called with `(METHOD)` only); BlockSprayPlan fails (called with no argument); source guard fails on `crop:      "Rose"` and on the missing `initialCrop` wiring.

- [ ] **Step 3: `spray-plan-creator-api.ts`** — replace lines 115-119:

```ts
/** `crop` is the route crop: the server narrows farms, greenhouses, blocks and
 *  the target catalogs to it (spec §2). Omitted → the old unscoped bootstrap. */
export async function fetchCreatorBootstrap(crop?: string): Promise<CreatorBootstrap> {
  return call<CreatorBootstrap>(
    "upande_scp.serverscripts.spray_plan_creator.bootstrap.fetch_creator_bootstrap",
    crop ? { crop } : {},
  );
}
```

- [ ] **Step 4: `ApplicationPlan.tsx`**

- Line 251: `export function ApplicationPlan() {` → `export function ApplicationPlan({ initialCrop }: { initialCrop?: string } = {}) {`
- Delete line 384 `      crop:      "Rose",` (the server takes the crop from the greenhouse).
- Line 401: `fetchCreatorBootstrap()` → `fetchCreatorBootstrap(initialCrop)`; add `initialCrop` to that effect's dependency array if it has one (keep `[]` otherwise — the crop is fixed for the mounted page, see `App.tsx:185`).
- Line 1523: `const fresh = await fetchCreatorBootstrap();` → `const fresh = await fetchCreatorBootstrap(initialCrop);`
- Line ~2091: `? "Pest + Disease catalog is empty — add entries in Frappe Desk."` → `? "No pests or diseases are linked to this crop yet — add them under Crop Scouted in Desk."`

- [ ] **Step 5: `BlockSprayPlan.tsx`** — add `crop = "Avocado",` to the destructured props after `targets = [],`, and to the props type:

```tsx
  /** The route crop — the bootstrap lists this crop's blocks, teams and kits. */
  crop?: string;
```

Replace the bootstrap effect (lines 72-76) with:

```tsx
  useEffect(() => {
    fetchCreatorBootstrap(crop)
      .then(setBoot)
      .catch((e) => setError(errorText(e, "Could not load planning data.")));
  }, [crop]);
```

- [ ] **Step 6: `AvocadoHeatMap.tsx`** — line 107 `export function AvocadoHeatMap() {` → `export function AvocadoHeatMap({ initialCrop = "Avocado" }: { initialCrop?: string } = {}) {`; line 109 `crop: "Avocado",` → `crop: initialCrop,`; line 684 `<BlockSprayPlan block={selectedAgg.block} targets={targets} />` → `<BlockSprayPlan block={selectedAgg.block} targets={targets} crop={filters.crop} />`.

- [ ] **Step 7: `App.tsx`** — in `case "heatmaps":` replace `<AvocadoHeatMap />` with `<AvocadoHeatMap initialCrop={cropName} />`; in `case "application-plan":` replace `return <ApplicationPlan />;` with `return <ApplicationPlan initialCrop={cropName} />;`.

- [ ] **Step 8: Run tests, typecheck, build**

`npx vitest run src/lib/spray-plan-creator-api.test.ts src/pages/avocado/__tests__/BlockSprayPlan.crop.test.tsx src/pages/__tests__/ApplicationPlan.crop.test.ts` → `3 passed (7 tests)`.
`npx vitest run` → all green. `npx tsc --noEmit -p tsconfig.app.json` → exit 0.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/spray-plan-creator-api.ts frontend/src/lib/spray-plan-creator-api.test.ts \
  frontend/src/pages/ApplicationPlan.tsx frontend/src/pages/__tests__/ApplicationPlan.crop.test.ts \
  frontend/src/pages/avocado/BlockSprayPlan.tsx frontend/src/pages/avocado/__tests__/BlockSprayPlan.crop.test.tsx \
  frontend/src/pages/avocado/AvocadoHeatMap.tsx frontend/src/App.tsx
git commit -m "feat(scp-ui): spray plans bootstrap for the route crop and diagnose stops sending a hard-coded rose"
```

---

### Task 10: Settings → Thresholds follows the route crop, then the manual pass

**Files:**
- Create: `frontend/src/components/settings/__tests__/ThresholdsTab.test.tsx`
- Modify: `frontend/src/components/settings/ThresholdsTab.tsx` (imports :35-43; :52-69; header :166-191)
- Modify: `frontend/src/pages/Settings.tsx:251`

**Interfaces:**
- Consumes: `getThresholds(crop)`, `saveThresholds(crop, bundle)` (`frontend/src/lib/thresholds-api.ts`), server guard (Task 6).
- Produces: `ThresholdsTab({ crop }: { crop: string })` — no picker, no `listCrops` call.

- [ ] **Step 1: Write the failing test** — `frontend/src/components/settings/__tests__/ThresholdsTab.test.tsx`

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getThresholds = vi.fn();
const saveThresholds = vi.fn();
const listCrops = vi.fn();
vi.mock("@/lib/thresholds-api", () => ({
  getThresholds: (...a: unknown[]) => getThresholds(...a),
  saveThresholds: (...a: unknown[]) => saveThresholds(...a),
  listCrops: (...a: unknown[]) => listCrops(...a),
}));

import { ThresholdsTab } from "@/components/settings/ThresholdsTab";

beforeEach(() => {
  getThresholds.mockReset().mockImplementation(async (crop: string) => ({ crop, pests: [], diseases: [] }));
  saveThresholds.mockReset().mockResolvedValue({ ok: true });
  listCrops.mockReset().mockResolvedValue(["Avocado", "Coffee", "Rose"]);
});

describe("ThresholdsTab", () => {
  it("loads the route crop and has no crop picker", async () => {
    render(<ThresholdsTab crop="Avocado" />);
    await waitFor(() => expect(getThresholds).toHaveBeenCalledWith("Avocado"));
    expect(listCrops).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Crop")).toBeNull();
  });

  it("follows the prop when the route crop changes", async () => {
    const { rerender } = render(<ThresholdsTab crop="Avocado" />);
    await waitFor(() => expect(getThresholds).toHaveBeenCalledWith("Avocado"));
    rerender(<ThresholdsTab crop="Coffee" />);
    await waitFor(() => expect(getThresholds).toHaveBeenLastCalledWith("Coffee"));
  });

  it("saves under the route crop", async () => {
    render(<ThresholdsTab crop="Avocado" />);
    const save = await screen.findByRole("button", { name: /save/i });
    await waitFor(() => expect(save).not.toBeDisabled());
    await userEvent.click(save);
    expect(saveThresholds).toHaveBeenCalledWith("Avocado", { crop: "Avocado", pests: [], diseases: [] });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

`cd /home/ubuntu/stive/code/frappe15/apps/upande_scp/frontend && npx vitest run src/components/settings/__tests__/ThresholdsTab.test.tsx`
Expected: `getThresholds` called with `"Avocado"` (from `listCrops()[0]`) only by accident of order; `listCrops` was called and the `Crop` label exists → first test fails; the rerender test fails (`Coffee` never requested).

- [ ] **Step 3: `ThresholdsTab.tsx`**

- In the `@/lib/thresholds-api` import, delete `listCrops,`.
- Replace `export function ThresholdsTab() {` and the two lines after it (`const [crops, …]`, `const [crop, setCrop] = …`) with:

```tsx
/** `crop` is the route crop (spec D7); the tab no longer carries its own picker. */
export function ThresholdsTab({ crop }: { crop: string }) {
```

- Delete the `listCrops()` effect (the first `useEffect`, lines ~61-69).
- In the header, change `<CardTitle className="text-base">Severity Thresholds</CardTitle>` to `<CardTitle className="text-base">Severity Thresholds{crop ? ` · ${crop}` : ""}</CardTitle>` and delete the whole `<div className="flex flex-col gap-1 min-w-44"> <Label htmlFor="th-crop">Crop</Label> <Select …> … </Select> </div>` block.
- In `<CardContent>`, directly after the `{error && (…)}` block, add:

```tsx
        {!crop && (
          <div className="text-xs text-muted-foreground py-6 text-center">
            Open Settings from a crop's section to edit its thresholds.
          </div>
        )}
```

- Update the file docstring's first paragraph: "The GM picks a crop" → "The crop is the route's (`#/<crop>/settings`)".

- [ ] **Step 4: `Settings.tsx`** — line 251: `<ThresholdsTab />` → `<ThresholdsTab crop={crop} />` (`crop` is already `(initialCrop || "").trim()` at line 77).

- [ ] **Step 5: Run tests, typecheck, build**

`npx vitest run src/components/settings/__tests__/ThresholdsTab.test.tsx` → `1 passed (3 tests)`.
`npx vitest run` → all green. `npx tsc --noEmit -p tsconfig.app.json` → exit 0. `yarn build` → completes without errors.

- [ ] **Step 6: Full server regression**

`cd /home/ubuntu/stive/code/frappe15/apps/upande_scp && ../../env/bin/python -m pytest -q upande_scp/serverscripts/tests/test_crop_catalog_pure.py upande_scp/serverscripts/tests/test_cache_invalidation.py upande_scp/serverscripts/tests/test_dashboard_aggregates_trends.py` → all pass.
DB-RUN each of: `test_crop_catalog`, `test_crop_scoped_aggregates`, `test_crop_scoped_aggregate_detail`, `test_crop_scoped_observations`, `test_crop_scoped_spray_plan`, `test_thresholds_crop_guard`, `test_crop_scope`, `test_spray_compliance_context`, `test_spray_compliance_api`, `test_dashboard_aggregates_common`, `test_get_complete_scouting_entries` → all `OK`.

- [ ] **Step 7: Manual pass** (spec §Testing)

`sudo -n supervisorctl restart frappe15-web:` then in the browser on kaitet.local:
1. `#/rose/application-plan` — farm and greenhouse pickers list no Lokitela; Preventive targets are the 12 Rose pests + 6 Rose diseases.
2. `#/avocado/heatmaps` (Jobsheet) — farm picker shows Lokitela only (no Karen); the spray panel's bootstrap request (Network tab) carries `crop=Avocado`.
3. `#/rose/trends` — the observation dropdown shows only Rose's 12 pests + 6 diseases (whatever has data in range); the request carries `crop=Rose`.
4. `#/rose/dashboard`, `#/rose/heatmaps`, `#/rose/settings` → Thresholds — no crop picker anywhere.
5. Network tab on each page: no request for `get_crops_with_farms`, and `get_farms_and_warehouses` always carries `crop`.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/settings/ThresholdsTab.tsx frontend/src/pages/Settings.tsx \
  frontend/src/components/settings/__tests__/ThresholdsTab.test.tsx
git commit -m "feat(scp-ui): settings thresholds follow the route crop and lose their own crop picker"
```
