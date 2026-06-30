# Chemical master doctype (Sub-project A) — design

**Date:** 2026-06-30
**Status:** Design — approved verbally, pending written review
**Next:** Sub-project B (Finances page) builds on this — it reads chemical → target
mappings from the `Chemical` master defined here. Separate spec.

## Problem

Chemical spray-flow metadata (targets, IRAC/FRAC/GHS, active ingredients,
toxicity, rate limits, type, re-entry) currently lives as ~18 `custom_*` fields
and child tables bolted onto the **Item** doctype. This overloads Item (a stock
master) with agronomy logic, and there's no first-class place to mark a chemical
*allowed* for spraying or to attach crop/target context cleanly.

We want the Pest → Pest Filter pattern for chemicals: the Item stays the stock /
valuation master, and a new **`Chemical`** doctype holds the spray metadata and
the *allowed* gate. Stock movements and valuations keep using the Item; the spray
flow reads metadata from `Chemical`.

## Goal / invariant

- A `Chemical` master, one row per chemical Item, is the source of truth for the
  spray flow's chemical metadata and for whether a chemical may be planned.
- Only `allowed` chemicals appear in the Application Floor Plan picker.
- Item stays untouched for stock/valuation; its `custom_*` chemical fields remain
  (deprecated, not deleted) so nothing else breaks, and are backfilled into
  `Chemical`.

## The `Chemical` doctype

Master doctype `Chemical` (not a child table; not single).

- `item` — **Link → Item**, `reqd`, `unique`. Link query filtered to the
  chemical item group ("Chemicals") so only chemical-type items can be picked.
- `chemical_name` — Data, fetched from `item.item_name` (read-only display);
  used for naming/search.
- `allowed` — **Check**, default 1. When 0, the chemical is hidden from the
  Application Floor Plan picker (and any "pick a chemical" surface).
- `crop_scouted` — **child table** (new child doctype `Chemical Crop`, one
  `Link → Crop Scouted` field) so one chemical can serve multiple crops.
  (A single `Link → Crop Scouted` is the fallback if multi-crop proves
  unnecessary.)
- `targets` — **child table**, reuse **Chemical Targets** (`pest` → Pest,
  `disease` → Plant Disease). *The Finances attribution (Sub-project B) reads
  this.*
- `active_ingredients` — child table, reuse **Active Ingredient**.
- `irac` / `frac` / `ghs` — MultiSelect, reuse the existing IRAC/FRAC/GHS Code
  Filter tables.
- `type` — Select (Insecticide / Fungicide / Adjuvant / pH Buffer …), mirrors
  `Item.custom_type`.
- `toxicity` — Select (I/II/III/IV).
- `reentry_interval_hrs`, `application_rate`, `lower_rate_limit`,
  `upper_rate_limit`, `pack_rate` — Float, mirror the Item custom fields.
- `description` — Small Text (notes / chemical compounds present).

Naming: `autoname = field:item` (1:1 with the Item code) so a Chemical is
trivially resolvable from an item_code and vice-versa.

## Backfill (idempotent patch)

`upande_scp/patches/v1_0/backfill_chemical_master.py`:
- For every Item in the chemical item group(s) without a `Chemical` row, create
  one, copying: targets, active_ingredients, irac/frac/ghs, type, toxicity,
  reentry, application_rate, rate limits from the Item `custom_*` fields.
- `allowed` defaults to 1 (existing chemicals stay usable); the GM can untick
  later.
- Idempotent: skip items that already have a `Chemical`.

## Reading layer (safe cutover)

Add `serverscripts/chemical_meta.py` — one resolver the spray flow uses instead
of reading Item `custom_*` directly:

- `get_chemical(item_code) -> dict | None` — the Chemical row (targets, irac,
  frac, rate limits, …), with **fallback to the Item custom fields** when no
  Chemical row exists yet (so partial backfills / new items never break).
- `allowed_chemical_codes() -> set[str]` — item codes whose Chemical is
  `allowed` (used to gate the picker).

Migrate these readers to the resolver (behaviour preserved, source switched):
- `spray_plan_creator/settings.py` — the Chemicals tab now lists/edits
  `Chemical` rows (allowed flag included), not Item custom fields.
- `spray_plan_creator/bootstrap.py` `_fetch_rate_limits` — from Chemical.
- the chemical **search/catalog** powering the Application Floor Plan picker —
  returns **allowed** chemicals only.
- `validate_frac_irac_guidelines.py`, `create_bom.py`, `spray_session.py` —
  read targets / IRAC / FRAC / rate limits via the resolver.

Stock balances, valuations, transfers, BOM quantities: **unchanged** (Item-based).

## Out of scope (this sub-project)

- The **Finances page** (Sub-project B) — separate spec; depends on
  `Chemical.targets`.
- Deleting the Item `custom_*` fields (left deprecated; a later cleanup once all
  readers are confirmed off them).
- A bulk admin UI beyond the existing Settings → Chemicals tab pointing at
  `Chemical`.

## Testing

- **Unit:** `chemical_meta.get_chemical` returns Chemical values when present and
  falls back to Item custom fields when absent; `allowed_chemical_codes` excludes
  un-allowed chemicals.
- **Migration (rolled-back console):** backfill creates one Chemical per chemical
  Item with matching targets/codes; re-running is a no-op.
- **Behaviour:** an un-allowed Chemical does not appear in the picker/catalog; an
  allowed one does. FRAC/IRAC and rate-limit validation give identical results
  before/after the source switch (resolver parity).
