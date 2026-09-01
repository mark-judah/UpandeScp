---
title: The Scouting Map
route: scp/using/the-scouting-map
order: 6
---

# The Scouting Map

`/scp_app#/<crop>/scouting-map` — sidebar **Scouting → Scouting**.

The map is the centre of the app. It shows the farm's growing structure and
paints onto it what scouts have found.

## What you are looking at

The farm is drawn from the structures set up in Desk:

| Roses | Avocado and coffee |
|---|---|
| **Greenhouses**, each holding **beds**, divided into **zones** | **Blocks**, holding **rows**, holding **trees** |

Both are the same idea at different scales — a place you can point at and say
what was found there. A scouting record always carries a location, so everything
on the map traces back to a specific bed or row.

## Reading it

Colour is severity. The scale, the colours and which observations rank highest
on which plant part are all configured by your administrator, so the map speaks
your farm's vocabulary rather than a generic one.

Choose the week you want to look at. The map is built around **ISO weeks** —
scouting is a weekly rhythm, and comparing this week with last week is the
question the map is built to answer.

## Overlays

Switch between observation types — pests, diseases, weeds, predators,
incidents, physiological disorders — to see the same ground under different
questions. A bed can be clean of disease and heavy with mites.

## Performance

The map is heavily cached, per ISO week. Opening it should be fast even on a
farm with a great deal of history; if it is not, that is worth reporting rather
than waiting out.

## Related views

| View | What it adds |
|---|---|
| **Heatmaps** | The same data as intensity across the farm, rather than per location |
| **Traps** | Trap positions and their catch counts |
| **Observations** | The underlying records as a list, when you want the detail rather than the picture |
| **Spraying** | Where spraying is happening now |

On avocado the heatmaps view is labelled **Jobsheet**, because that is what it
is used for — prescribing a block to spray straight from the map.
