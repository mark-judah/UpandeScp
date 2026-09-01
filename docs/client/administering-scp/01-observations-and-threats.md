---
title: Observations and threats
route: scp/admin/observations-and-threats
order: 2
---

# Observations and threats

**Sidebar → Observations & Threats.** These seven doctypes are the vocabulary a
scout picks from. Nothing can be scouted that is not defined here.

| Sidebar | DocType |
|---|---|
| Pests | `Pest` |
| Diseases | `Plant Disease` |
| Weeds | `Weed` |
| Predators | `Predator` |
| Incidents | `Incident` |
| Physiological Disorders | `Physiological Disorder` |
| Traps | `Trap` |

## The shape of a threat record

Taking **Pest** as the model — the others follow the same pattern:

| Field | Purpose |
|---|---|
| `common_name` | The record's name. What scouts see |
| `scientific_name` | |
| `identification_guideline` | How to tell it apart in the field |
| `damage_symptoms` | An image — what the damage looks like |
| `pests_legend_color` | The colour it takes on the map and in reports |
| `severity` | A **Scouting Severity Scale** child table |

The colour is not decoration. It is what the scouting map, the heatmaps and the
reports all key off, so a colour chosen carelessly makes the map harder to read.
Keep the palette consistent across crops.

## Filters — the important part

Each threat has a matching **Filter** doctype: `Pest Filter`, `Disease Filter`,
`Weed Filter`, `Predator Filter`, `Incident Filter`, `Physiological Disorder
Filter`, `Trap Filter`.

The threat record says *what the thing is*. The filter says *how it behaves on
this crop*:

| Field | Purpose |
|---|---|
| `crop_scouted` | Which crop this filter applies to — **Pest Filter and Disease Filter only** |
| `pest` (or the equivalent) | Which threat |
| `unit` | How it is counted — Per Zone %, Per Warehouse, Per Hectare and so on |
| `low` / `moderate` / `high_threshold` | The severity bands |
| `stages` | Which life stages can be recorded |
| `priorities` | A **Filter Priority** child table — the order stages and threats appear per plant part |

### Only two filter types are per-crop

This catches people out. **`Pest Filter` and `Disease Filter` carry
`crop_scouted`; the other five do not.**

| Filter | Per crop? |
|---|---|
| Pest Filter, Disease Filter | **yes** — one row per pest/disease *per crop* |
| Weed, Predator, Incident, Physiological Disorder, Trap Filter | no — one row, shared by every crop |

So a pest can be a minor nuisance on roses and an action threshold on avocado,
because each crop has its own thresholds and stages. A weed cannot: change its
filter and you change it everywhere.

**A pest or disease with no filter for a crop is not scoutable on that crop.**
If a scout says something is missing from their list, that is the first place to
look. As configured today: roses have 12 pests and 6 diseases, avocado 12 and 4,
coffee 16 and 5.

Filters are standalone records, not children of the threat. That was a
deliberate change — nesting them meant grandchild stage rows could be orphaned.

## Stages

`Stage` is a shared catalogue of life stages and condition stages — egg, larva,
adult; fresh, dry, latent.

| Field | Purpose |
|---|---|
| `stage_name` | The record name |
| `icon_key` | Which icon represents it in the app, heatmaps and reports |
| `default_reading_type` | Count, Checkbox or Range |

Pest and disease stages **link to this catalogue** rather than redefining stages
per threat. That is what lets the heatmap and the reports draw a consistent icon
for "larva" wherever it appears.

`default_reading_type` decides how a scout is asked for the reading: a number, a
tick, or a range. Set it wrong and scouts are asked for data they cannot give.

## Crops

`Crop Scouted` is the crop master that filters hang off. It is SCP's own
doctype — distinct from the sidebar's "Crops" entry, which opens the ERPNext
Item list.

## Adding a new pest — the checklist

1. Create the `Pest` record: name, scientific name, identification guideline,
   damage image, legend colour.
2. Add its severity scale.
3. Create a `Pest Filter` for **each crop** it applies to: unit, thresholds,
   stages, priorities. One filter per crop — a pest on all three crops needs
   three.
4. Check the stages you referenced exist in the `Stage` catalogue with the right
   icon and reading type.

Skip step 3 and the pest exists but cannot be recorded.
