# Mobile Observation Ordering & Per-Plant-Part Ranking

**Date:** 2026-06-01
**Status:** Approved (pending spec review)
**Author:** dev@upande.com (with Claude)

## Problem

On the mobile scouting screen (RN app `upande_scout_rn`, `app/(tabs)/index.tsx`),
three issues hurt usability:

1. **Plant-part tabs are in an awkward order** (e.g. Stem, Middle, Top, Base, Buds)
   — driven by the crop's `allowed_plant_sections` order. Scouts want a consistent,
   purposeful order: **Buds, Top, Stem, Base, then the rest**.
2. **Empty category sections still render** a "No fields available for this plant
   part" placeholder for every category except Predators — noise (e.g. a Weeds
   section under Buds with nothing in it).
3. **Pests/diseases are unordered** within a section (backend `idx` order). Scouts
   want the most notable observations first, and the priority differs **per plant
   part** (e.g. Thrips first under Buds, but not necessarily under Stem).

## Decisions (from brainstorming)

- Plant-part order is a **fixed app-side preference** (not per-crop configurable).
- Empty sections are **removed entirely** for all categories.
- Ranking is **per plant-part** (a rank per pest/disease × plant section).
- Ranking is configured **on the standalone Pest Filter / Disease Filter form**
  (MVP) — the same place per-crop thresholds already live. No new web Settings tab
  in this phase.

## Scope

Spans two repos:
- Backend: `apps/upande_scp` (new child doctype, doctype JSON, mobile endpoint).
- Mobile: `reactnative/Upande-Scout/upande_scout_rn` (tab order, hide-empty, sort).

The web Settings "Ordering" matrix tab is explicitly **out of scope** (possible
phase 2).

---

## Part 1 — Plant-part tab order (RN only)

`app/(tabs)/index.tsx` builds `plantParts` from `allowedPlantSections` (or the
`BASE_PLANT_PARTS` fallback). Add a fixed preferred-order sort applied to the final
`plantParts` array:

```
PREFERRED = ["buds", "top", "middle", "stem", "base"]
```

Sort rule: parts whose `value` is in `PREFERRED` come first, in `PREFERRED` order;
all other parts follow in their existing order; **`comments` always stays last**
(it is appended after the sort, as today). This works for both the API-driven and
fallback tab lists.

No backend change.

## Part 2 — Remove empty sections (RN only)

In `renderCategoryContentForPart` (`app/(tabs)/index.tsx`), the
`applicableFields.length === 0` branch currently returns `null` only for
"Predators" and otherwise renders the placeholder `Text`. Change it to return
`null` for **every** category when there are no applicable fields. `renderCategoryCard`
already drops null content (`if (!content) return null`), so the empty section's
card is not rendered at all.

No backend change.

## Part 3 — Per-plant-part ranking

### Data model

- **New child doctype `Filter Priority`** (`istable: 1`), module Upande Scp:
  - `plant_section` — Link → Plant Section, `in_list_view`, reqd.
  - `priority` — Int, `in_list_view` (1 = shown first; lower = higher).
- Add a `priorities` **Table** field (`options: "Filter Priority"`) to **Pest Filter**
  and **Disease Filter** (after the `stages` table).

Each per-crop Pest Filter / Disease Filter row therefore carries a list of
`{plant_section, priority}`. Operators edit it inline on the standalone filter form
(reached via Crop Scouted → Connections), beside the existing thresholds and stages.

### Backend — `getObservationsDetails`

When a `crop` is supplied (the app always supplies one):
- For the crop's Pest Filter rows (already fetched as `filter_rows` with
  `name, pest`), fetch their `Filter Priority` children:
  `{filter_row_name: {plant_section_lower: priority}}`.
- Map filter row → pest via the existing `row_to_pest`, producing
  `pest_priorities[pest_name] = {plant_section_lower: priority}`.
- Attach `"priorities": pest_priorities.get(pest.name, {})` to each pest field.
- Do the same for diseases via the Disease Filter rows / `row_to_disease`.

Plant-section keys are lowercased to match the RN tab `value`s (`"buds"`, `"top"`,
…). When no `crop` is supplied, `priorities` is `{}` (no ranking) — unchanged behavior.

Response shape stays backward-compatible: a new optional `priorities` object per
pest/disease field; all existing keys unchanged.

### Mobile — sort by the selected plant part

In `renderCategoryContentForPart(cat, partValue)`, the grouped accordions come from
`cat.groupedByPart[partValue]` (a `{mainName: fields[]}` object). Before rendering,
sort the group entries by the group's priority for `partValue`:

- A group's priority = `fields[0].priorities?.[partValue]` (all stages of a pest
  share the same per-pest priorities map).
- Ascending; groups with no priority for this part sort **after** ranked ones,
  preserving their existing relative order (stable sort) — "the rest follow".

Applies to Pests and Diseases (and harmlessly to Predators, which carry no
priorities). The cached SQLite payload already stores the full response JSON, so the
new `priorities` field is persisted and read back with no schema change.

---

## Migration / seeding

No data migration required. `Filter Priority` rows are created by operators as they
configure ranking; absent priorities mean "unranked" (current order preserved). The
`Filter Priority` doctype ships as app code; nothing to backfill.

## Testing / verification

- **Backend:** call `getObservationsDetails(crop)` after adding a couple of
  `Filter Priority` rows to a Pest Filter; assert each pest field carries the
  `priorities` map with lowercased section keys.
- **Mobile (manual):** with priorities set (e.g. Thrips Buds=1), open the app on that
  crop → Buds tab shows Thrips first; switch to Stem → order reflects Stem priorities;
  unranked pests follow; empty sections (e.g. Weeds under Buds) are gone; tab order is
  Buds, Top, Middle, Stem, Base, then the rest.

## Out of scope

- Web Settings "Ordering" matrix tab (phase 2).
- Per-crop-configurable plant-part tab order (kept a fixed app preference).
- Changing how stages (within a pest) are ordered — only the pest/disease group order
  is ranked.
