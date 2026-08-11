# Chemical code search + searchable BOM picker

**Date:** 2026-08-10
**Status:** approved, implementing

## Problem

Two friction points on the React Application Plan (`frontend/src/pages/ApplicationPlan.tsx`):

1. **Chemicals can only be found by name.** `list_chemical_items` filters on
   `item_name like %q%` only, so typing an item code returns nothing. Verified on
   `kaitet.local`: `q="1111155009"` → `[]`, while `q="2-4D Herbicide"` returns that
   same item. Operators who work from codes see an apparently broken search.

2. **The BOM picker is an unfiltered dropdown of 2,426 options.** Every active
   Chemical Mix BOM mounts as a `SelectItem` at once
   (`SELECT COUNT(*) FROM tabBOM WHERE custom_item_group='Chemical Mix' AND
   is_active=1 AND docstatus=1` → 2,426), so the only way to reach one is
   scrolling. The bulk DOM mount is also why the list feels sluggish.

## Scope decision

The picker keeps offering **all** BOMs. Farm-scoping the default list was
considered and rejected: `bootstrap.py` deliberately ships every active mix
regardless of farm ("the operator can pick any BOM and the per-row
chemical-warehouse selector handles the actual source restriction"), and narrowing
it would be a behaviour change rather than a search feature.

## Part 1 — Search chemicals by name or code

Server-side, one endpoint: `upande_scp/serverscripts/scouting/scouting_metrics_api.py`
`list_chemical_items`.

Keep the AND filters (`disabled = 0`, `item_group in product_groups()`) and add
Frappe's `or_filters` for the search term:

```python
filters    = [["Item", "disabled", "=", 0],
              ["Item", "item_group", "in", list(groups)]]
or_filters = [["Item", "item_name", "like", f"%{q}%"],
              ["Item", "name",      "like", f"%{q}%"]]
```

`or_filters` groups into a single parenthesised `OR` block ANDed with `filters`
(`frappe/model/db_query.py`), so the item-group restriction cannot leak.

This endpoint backs both the **Add chemical** dialog and the **New BOM** chemical
search, so both gain code search from the one change. The dialog's description
changes from "Search by item name" to "Search by item name or code".

**Known consequence:** codes share long digit runs, so short numeric queries
return broader result sets than name queries. The existing `limit` (50) and
`item_name asc` ordering keep this usable; no extra ranking.

## Part 2 — Searchable BOM picker

Client-only. `bootstrap.tank_mixes` already carries every BOM (`name`,
`item_name`, `custom_farm`), so no endpoint work.

### New component: `frontend/src/components/BomPicker.tsx`

Popover + Input + scrollable result list, deliberately mirroring the existing
Add-chemical dialog (search field above a list of `button` rows) so the page keeps
one search idiom. Built on the existing `ui/popover.tsx` and `ui/input.tsx`.

`cmdk` is in `package.json` but imported nowhere; adding shadcn's `command.tsx`
just for this picker is not worth a new UI primitive.

Contract — a drop-in for the `<Select>` it replaces:

```ts
type BomOption = { name: string; item_name?: string; custom_farm?: string };
type Props = {
  boms: BomOption[];
  value: string;
  onValueChange: (name: string) => void;
};
```

Behaviour:

- Filters case-insensitively across **mix name, BOM name and farm**.
- Renders at most 50 matches, with a `2,426 BOMs · showing 50 — refine your
  search` footer. This cap is the fix for the sluggishness.
- Trigger shows the selected BOM's `item_name` (falling back to `name`) plus farm
  — the same label the old `SelectItem` rendered.
- Keyboard: type to filter, ↑/↓ to move the highlight, Enter to pick, Escape to
  close.
- Empty state: `No BOM matches "<query>"`.
- A missing `custom_farm` is treated as `""` and omitted from the label.
  `bootstrap.py` adds that field behind a `has_column` guard and the field has
  gone missing on this site before, so the picker degrades instead of crashing.

### Call site

Replaces the `<Select>` at `ApplicationPlan.tsx:1910`, keeping the same
`value`/`onValueChange` wiring so no downstream state changes.

## Testing

- **Python** (`upande_scp/serverscripts/tests/test_crop_protection.py`): assert
  `list_chemical_items` finds a test item by its `item_code` as well as its name.
- **Vitest**: the filter is a pure `filterBoms(list, query, limit)` exported from
  the component module and unit-tested for match-by-each-field,
  case-insensitivity, the render cap, and the no-match case. Follows the existing
  `frontend/src/lib/*.test.ts` convention.

## Found during implementation

Two things the design didn't anticipate, both fixed:

1. **No `.test.tsx` file had ever run.** `frontend/vitest.config.ts` shadows the
   `test` block in `vite.config.ts` and restricted collection to
   `src/**/*.test.ts` with `environment: "node"` — so `AppSidebar.test.tsx` and
   the `test-setup.ts` jsdom setup were both dead. Widened `include` to `.tsx`,
   restored `environment: "jsdom"` + `setupFiles`, and added a `ResizeObserver`
   stub to `test-setup.ts` alongside the existing `matchMedia` one (AppSidebar's
   scroll-shadow effect constructs one on mount).

   Enabling the file surfaced two stale expectations in `AppSidebar.test.tsx`:
   `"Rose Scouting"` (the nav item is now labelled plain `"Scouting"`) and
   `"Job Sheets"` (a string that exists nowhere — written ahead of a feature that
   never landed). Both left `it.skip` with notes rather than rewritten to match
   the code, plus one new test covering crop-scoped nav as it actually is.
   **Needs a human decision** on whether the avocado job-sheet nav is still
   wanted.

2. **`scrollIntoView` needed guarding.** The keyboard-nav effect called it
   unconditionally; jsdom (and older browsers) don't implement it, so it threw
   mid-render. Now an optional call — losing the scroll is acceptable, throwing
   is not.

## Out of scope

- Ranking or fuzzy matching on either search.
- Farm-scoping the BOM list (see Scope decision).
- The separate finding that a zero-stock chemical shows in the picker but blocks
  Submit via `stockShortRows` — existing, intended behaviour.
