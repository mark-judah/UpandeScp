# Traps are fixed locations

**Date:** 2026-10-10 · **Branch:** kaitet · **Status:** built

## Problem

A Trap had no position of its own. Maps drew each trap at the average of the
coordinates of the scouting entries that recorded it, so a trap "moved" with
every window and with every bad fix. Zones have a `geojson`; traps did not.

Since 2026-09-03 every scouting entry carries a `Scouting Entry Metadata` row
with the phone's fused GPS fix and its reported accuracy. A trap does not move,
so each entry recorded at a trap is a fix of the same spot — enough to place it
without a walk-round.

## Decisions

### T1 — Trap fields
| field | type | notes |
|---|---|---|
| `geojson` | **Geolocation** | FeatureCollection with one Point `[lng, lat]` and properties (`trap`, `source`, `fixes`, `spread_m`, `house_distance_m`) |
| `location_source` | Select `\nGPS estimate\nManual` | Manual is never overwritten |
| `location_fixes` | Int, read only | fixes kept after outlier removal |
| `location_spread_m` | Float, read only | p90 distance of kept fixes from the estimate |
| `location_updated` | Datetime, read only | |
| `location_flag` | Data, read only | `outside house` |

`geojson` is a **Geolocation** field rather than JSON: it stores the same
FeatureCollection wrapper `Zone.geojson` uses (so `parse_geojson` and friends
read it unchanged) and desk renders it on a Leaflet map, where it can be edited.
Editing it on the form sets `location_source = Manual` (`Trap.validate`); the
estimator writes with `db.set_value`, which bypasses that hook.
Applied with `reload_doc` (no migrate).

### T2 — Estimator (`serverscripts/traps/`)
`trap_geometry.py` is pure (no frappe): `estimate`, `distance_to_geometries`,
`flag_for`, `to_geojson`, `point_of`. `trap_location.py` is the DB side.

1. One SQL query collects every fix: entries whose trap rows name **exactly one
   distinct trap** (an entry naming several traps has one fix for several
   places — excluded), joined to their metadata, `0 < gps_accuracy <= 5 m`.
2. Per trap: per-coordinate median → drop fixes > 15 m from it → recompute the
   median → need ≥ 3 kept fixes, else skip.
3. Spread = p90 distance of the kept fixes.
4. Sanity: distance from the estimate to the nearest Zone line of the trap's
   house (for a house with no zones, e.g. an orchard block, its
   `custom_raw_geojson` polygon; 0 inside). Flag `outside house` when > 30 m
   (Indoor) or > 100 m (Outdoor). Flagged traps are still stored.
5. `Manual` traps are skipped. A trap that has too few fixes keeps whatever it
   had. An unchanged estimate is not rewritten.

No recency weighting (traps do not move; a moved trap should be set Manual).

### T3 — Entry points
* `estimate_trap_locations(farm=None, trap=None, dry_run=1)` — whitelisted,
  `frappe.only_for(System Manager, SCP General Manager)`; returns
  `{traps, placed, unchanged, skipped_too_few, no_fixes, unchanged_manual,
  flagged, per_farm, flagged_traps}`.
* `daily_refresh` — `scheduler_events.daily`; recomputes all GPS estimates.
* `get_trap_locations(farm=None)` — `{trap: {lat, lng, source, fixes, spread_m, flag}}`
  for the maps; permission-filtered `get_all`.
* Desk: "Estimate location from GPS" on the Trap form (that trap) and
  "Estimate locations from GPS" on the list (a farm or all). Both preview with a
  dry run and ask before writing (`public/js/trap_estimate.js`).

### T4 — Maps
The trap layers are computed client-side from the scouting payload, not from a
dashboard aggregate, so no aggregate payload changed and `K_DASH_AGG_SCHEMA`
stays `gal1`. `TrapsMap` (roses) and `AvocadoTraps` fetch `get_trap_locations`
once and draw a trap at its fixed point when it has one, otherwise at the
average of its entries' coordinates as before. The popup says which.

## Known limits
* Entries that batch several traps (common at Kapkolia, Simotwo and Karen) give
  no usable fix; those traps stay unplaced until scouts record one trap per
  entry or someone places them manually.
* Metadata only exists from 2026-09-03; nothing earlier to use.
* A flag can mean bad house geometry rather than a misplaced trap (see the
  run report: all flags on the first run are one house).
