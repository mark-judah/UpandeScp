# Open-field Application Plan (merged with Spray Plan), pest colours, traps on units, 3D spheres

Date: 2026-10-29. Branch `mutara`. Approved by the user in chat. Reference: roses (kaitet checkout) Application Plan,
TrapsMap, lib/heat-style.ts, lib/trap-pulse.ts, pages/maps/TreesLayer.ts.

1. **One page.** For block-grown crops the Application Plan (`AvocadoHeatMap`) absorbs the open-field Spray Plan
   (`OpenFieldPlan`); route `open-field-plan` redirects to `application-plan`; the sidebar shows one "Application Plan".
   Layout: **map on the left**, **docked planning column on the right** (block list = `BlockMultiPicker`, synced with map
   clicks, select-all per pivot/phase; then one `BlockPlanPanel` per selected block with the jump list and collapse;
   `createDraftPlansBatch` submits all; `DraftBatchPanel` below). **Undocked**: clicking a block / hexagon / trap opens a
   `MapFloatingCard` over the map with its details. Greenhouse (rose) Application Plan unchanged.
2. **Observations map is always 2D** for open field (no tilt; pitch locked to 0).
3. **Heat in the pest's own colour** (from `useObservationColors`), intensity as opacity (roses `heat-style` levels) —
   no green/amber/red (`FIELD_COLORS` removed from open-field views). Pivots (hexagons/triads): solid fill per hexagon.
   Avocado (trees/visit points): IDW smear in the pest's tones. **Per-unit setting** Warehouse custom field
   `custom_heat_style` Select `Smear\nSolid` (default by crop: hexagon blocks Solid, avocado Smear) added through SCP's
   `custom_fields` spec; the map honours it per block.
4. **Traps on a unit.** Trap gets `custom_unit_type` Select (Triad / Orchard Tree / Bed) + `custom_unit` Dynamic Link;
   the trap takes that unit's geometry (triad hexagon / tree point / bed line) and falls back to `geojson`. On the map the
   unit is outlined with the **trap number** label; markers pulse like roses (`trap-pulse`, size by catch, pest colour).
   Click → fly to it → `TrapReadingCard` in the undocked card. Trap form + mobile trap endpoints accept the unit.
5. **3D view** on the Application Plan map (2D/3D switch): each scouting value is an **icosphere** (Three.js
   `IcosahedronGeometry`, instanced, like `TreesLayer`) on its hexagon/tree, pest colour, radius by value, gentle pulse
   (scale animation), honouring reduced motion.
Tests: vitest for the merged page (map clicks ↔ list, batch submit), colour mapping (pest colour + opacity, no red/green),
heat-style switch, trap unit geometry + click card, sphere sizing; backend tests for the trap unit field and geometry.
Seed: link a few Mutara demo traps to triads/trees so the map shows them.
