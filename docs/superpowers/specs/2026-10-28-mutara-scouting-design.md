# Mutara scouting & crop protection — design (2026-10-28)

Branch: `mutara` of upande_scp, bench `/mnt/data/code/frappe16-mutara`, site `mutara.local`.
Developed in parallel with the `kaitet` branch; shared fixes are merged across by hand.

## What Mutara grows

- **Avocado** in orchard blocks: `Farm → Phase → Section → Block → rows → trees`.
- **Fruits & vegetables** (Potato, Onion, Cabbage, Passion Fruit) in centre pivots:
  `Farm → Pivot → Block`. A pivot's blocks are its pizza slices. Each block rotates
  crop by season.

Kaitet's avocado is `Farm → Section → Block → rows → trees`. Mutara adds the Phase
level above Section, and a second kind of section, the Pivot.

## Source of truth for "what is planted where"

`upande_production` (installed on mutara) already holds it:

- `Production Unit` tree: `Orchard Block`, `Pivot` (group), `Pivot Block` (the slices
  P1-B1 … P4-B4), with `crop` = `Production Crop` (`Avocado`, `Fruits & Vegetables`).
- `Production Crop Cycle`: per unit, `item` (Potatoes / Cabbage / Onion / Passion Fruit
  / Hass Avocado …), `start_date`, `expected_harvest_end`, `status`
  (Planned / Active / Harvesting / Closed).

SCP does not keep a second planting record. It reads the cycle.

## D1. Location tree (Warehouses)

SCP stations stay Warehouses (stock and chemicals need them). On mutara:

- New Warehouse Types **Phase** and **Pivot** (groups). `Section` already exists.
- Avocado: `Mutara (Farm)` → `Phase …` → `Section …` → `Block` (station).
- Veg: `Mutara (Farm)` → `Pivot …` → `Block` (station, one per slice).
- Station types setting stays `Greenhouse, Block`. Phase / Section / Pivot are
  never stations.
- Rows under a block are `Bed` records (`unit_type` Row for avocado, Bed for veg);
  trees are `Orchard Tree`, as on kaitet.

## D2. Fields (owned by agent A)

- `Warehouse.custom_production_unit` (Link `Production Unit`, SCP-owned custom field,
  `module` = Upande Scp). Links a station to its production unit.
- `Warehouse.custom_crop` (Link `Crop Scouted`). A fixed crop on a station **or any
  ancestor** (e.g. set on a Phase = Avocado). The fallback when no production link
  or no live cycle exists, and the only mechanism on a site without upande_production.
- `Crop Scouted.production_items` (Table → new child `SCP Crop Production Item`
  {`item` Link Item}): which production items count as this crop. Config, not code:
  never match crops by name (see the no-hard-coded-names rule).
- New Crop Scouted records on mutara: Avocado, Potato, Onion, Cabbage, Passion Fruit
  (created by agent D, tagged to farm Mutara).

## D3. Crop resolution — `upande_scp/serverscripts/common/planting.py` (agent A)

```python
def crop_for_station(station: str, on_date=None) -> str | None
def crops_for_stations(stations: list[str], on_date=None) -> dict[str, str | None]  # batched, no N+1
def stations_for_crop(farm: str, crop: str, on_date=None) -> list[str]
```

Order:
1. `custom_production_unit` set and `upande_production` installed → that unit's cycle
   covering `on_date` (start_date ≤ date, status in Planned/Active/Harvesting, latest
   start wins) → `item` → the Crop Scouted whose `production_items` holds it.
2. Otherwise the nearest `custom_crop` walking up the warehouse tree (station first).
3. Otherwise `None` (fallow / unknown). `None` stations are still listed when no crop
   filter is asked for.

`farm_map.stations_for_farm(farm, crop=None, on_date=None)`: when `crop` is given,
returns only stations resolving to it. Existing callers without `crop` are unchanged.

`Scouting Entry.validate`: fill a blank `crop_scouted` from the station
(`greenhouse` or `block`) on `date_of_capture`.

## D4. Mobile hierarchy (agent B)

`mobile/get_farm_hierarchy_info.getFarmHierarchyInfo` and
`mobile/get_farm_data_bundle`:

- Keep today's keys so the current Scout app keeps working. `sections` becomes the
  **direct parents of stations** (Section or Pivot), wherever they sit in the tree,
  not only children of the farm warehouse.
- Add `levels`: every group warehouse between the farm and the stations
  `{name, warehouse_name, warehouse_type, parent}` (Phase, Section, Pivot) so the app
  can drill Phase → Section → Block or Pivot → Block.
- Each station in the bundle gains `parent` and `crop` (resolved for today via
  `planting.crops_for_stations`). Optional `crop` argument filters stations.
- The React Native Scout app change (Phase picker) is a later, separate task.

## D5. Pests & diseases (agent C)

- Copy kaitet.local's Avocado pests, diseases, stages, Pest/Disease Filter rows,
  colours and ID guidelines to mutara.local, through a repo seed file (not a DB dump).
- Research and seed the common Kenyan pests and diseases for Potato, Onion, Cabbage,
  Passion Fruit (Infonet-Biovision, CABI, KALRO, EPPO), with scientific names, ID
  guidelines, life / disease stages, colours. Fill-blanks-only, like
  `scouting/seed_pests_diseases.py`.

## D6. Site setup (agent D, after A)

Script `upande_scp/serverscripts/migrate/seed_mutara_locations.py`, idempotent:
Warehouse Types, Crop Scouted records + production_items, the warehouse tree mirrored
from the Production Units (Phases/Sections for avocado as demo values until Mutara
gives the real names), `custom_production_unit` links, demo rows/beds.

## D7. Desk frontend (agent E, after A)

Crops Potato / Onion / Cabbage / Passion Fruit get their own `#/<crop>/…` sections.
"Grown on blocks" comes from data (the crop's station type), not a name list. Section
filter labels follow the level names (Phase / Section / Pivot).

## Rules for every agent

- Work only in `/mnt/data/code/frappe16-mutara/apps/upande_scp` (branch `mutara`).
  Never touch the kaitet bench or any other bench.
- Never use the Kaitet MCP. Data: `bench --site <site> mariadb|console|execute`.
- Do not commit. Do not run `bench migrate` or `bench build` unless your brief says so.
- Never restart MariaDB. Never change DB passwords.
- Match surrounding code style (tabs vs spaces per file).
