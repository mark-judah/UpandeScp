---
title: Farm and infrastructure
route: scp/admin/farm-and-infrastructure
order: 3
---

# Farm and infrastructure

**Sidebar → Farm & Infrastructure.** The skeleton the scouting map is drawn on.

## The hierarchy

Roses and the tree crops describe the same idea at different scales:

| Roses | Avocado / coffee | Stored as |
|---|---|---|
| Greenhouse | Block | `Warehouse` |
| Bed | Row | `Bed` |
| Zone | Tree | `Zone` / `Orchard Tree` |

A scouting entry carries the location at whichever level applies, plus latitude
and longitude. That is what puts it on the map.

## Greenhouses are Warehouses

The sidebar's **Greenhouses** entry opens the `Warehouse` list. There is no
Greenhouse doctype.

This has real consequences:

- A greenhouse is a stock location. Chemicals are issued to it and costs post
  against it.
- Its **cost centre** is derived from the greenhouse, so a greenhouse without
  one will fail spray-plan creation with an explicit message about deriving the
  cost centre.
- Renaming or disabling a warehouse affects stock, not just the map.

Warehouse carries a `custom_farm` field, and that is the **only** link between a
warehouse and a Farm. Nothing else establishes it.

### Which greenhouses appear in a spray plan

Not all of them. Two settings in **Scouting and Crop Protection Settings → Spray
Plan** filter the dropdown:

| Setting | Effect |
|---|---|
| **Allowed Farms** | Only greenhouses on this list are offered at all |
| **Exclude Keywords** | Case-insensitive substrings; any greenhouse whose name contains one is dropped |

Users are additionally scoped to the farms they are assigned to. When someone
reports a missing greenhouse, check all three before assuming a bug.

## Beds and Zones belong to upande_core

`Bed` and `Zone` are real doctypes, but they are **owned by upande_core**, not by
SCP. Other apps read them. Treat changes there as cross-app changes rather than
SCP configuration.

## Crops

The sidebar's **Crops** entry opens the `Item` list. Crops are Items — usually
the varieties being grown.

Note the distinction from `Crop Scouted`, which is SCP's own crop master and is
what observation filters key off. The two are not the same list and are not kept
in step automatically.

## Map Settings

A small doctype that positions the map:

| Field | Purpose |
|---|---|
| `lat`, `lon` | Where the map centres |
| `default_zoom` | How far in it opens |
| `farm_coordinates` | A **Farm Map Coordinate** child table — per-farm positions |

If the map opens on the wrong part of the world, this is the fix, and it is the
only place to make it.

## Automation helpers

Several doctypes exist to generate structure in bulk rather than by hand:

| DocType | Generates |
|---|---|
| `Bed and Zone Automation` | Beds and zones for a greenhouse |
| `Tree and Row Automation` | Rows and trees for a block |
| `Field Unit Automation`, `Field Unit Sector` | Field units and their sectors |
| `Greenhouse Sectors`, `Block Sectors` | Sector subdivisions |

Use these when setting up a new greenhouse or block. Creating hundreds of zones
by hand is what they exist to avoid.
