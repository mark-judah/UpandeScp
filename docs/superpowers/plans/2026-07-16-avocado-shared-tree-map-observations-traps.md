# Avocado Shared Tree-Map (Observations & Traps) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render avocado Observations and Traps on the shared 3D tree map from the same cached scouting fetch, by extracting a reusable `AvocadoTreeMap` shell; drop the "· 3D" headings.

**Architecture:** Pull the map machinery out of `AvocadoMap.tsx` into one `AvocadoTreeMap` shell (owns `MapHeader` filters, `Map3D` + `TreesLayer`, block/tank layers, loader, docked panel, single-farm auto-select, cached `useScouting` + tree points). It renders a **view descriptor** each view supplies: `deriveColors(data)`, optional `deriveMarkers(data)`, `renderPanel(data)`, `headerControls`, `title/subtitle`, `showTracks`. Scouting / Observations / Traps become thin wrappers; per-view logic lives in small pure, tested `derive-*.ts` modules.

**Tech Stack:** React + TypeScript, Vitest; MapLibre (`Map3D`) + Three.js (`TreesLayer`, unchanged); `useScouting` (IDB-cached); observation-colors + scouting-types libs.

## Global Constraints

- **Commit messages:** NEVER add a `Co-Authored-By: Claude …` trailer (repo rule).
- **Do not modify** `frontend/src/pages/maps/TreesLayer.ts`, `Map3D`, `MapBase`, or the **rose** `Observations.tsx` / `TrapsMap.tsx` / `RoseScouting.tsx` — rose keeps its Leaflet views; the crop is fixed by the route.
- **No backend changes.** Everything derives from the existing `useScouting` `ProcessedData` (`data.entries: ScoutingEntry[]`) + `fetchOrchardTreeRows`. `ScoutingEntry` fields: `tree`, `scouts_name`, `latitude?`, `longitude?`, `block`, `row`, `pests_scouting_entry: {pest,count}[]`, `diseases_scouting_entry: {disease}[]`, `trap_scouting_entry: {trap,count,location?}[]`.
- **Headings** carry no "· 3D": "Scouting Map" / "Observations" / "Traps".
- **Colours** must match the map: scout palette assignment is first-seen order; observation colours are the canonical `pestColor`/`diseaseColor` (default `OBS_DEFAULT_COLOR = "#9ca3af"`); trap markers use the severity ramp below.
- **Frontend test command** (from `frontend/`): `yarn vitest run <file>`
- **Build/deploy:** `yarn build` in `frontend/`, then `cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local clear-cache`. Do NOT commit built `dist/` (gitignored). Verify data only via `kaitet.local` bench — never a Kaitet MCP.

## File Structure

- `frontend/src/pages/avocado/tree-map-types.ts` — **create**: `MarkerPoint`, `AvocadoView` interfaces (shared, no React import → no cycles).
- `frontend/src/pages/avocado/derive-scouts.ts` — **create**: `SCOUT_PALETTE`, `deriveScoutColors`, `deriveScoutRoster`.
- `frontend/src/pages/avocado/derive-observations.ts` — **create**: `deriveObservationColors`, `deriveObservationRoster`.
- `frontend/src/pages/avocado/derive-traps.ts` — **create**: `severityColor`, `deriveTrapMarkers`.
- `frontend/src/pages/avocado/derive.test.ts` — **create**: Vitest for all three.
- `frontend/src/pages/avocado/AvocadoTreeMap.tsx` — **create**: the reusable shell (extracted from `AvocadoMap.tsx`).
- `frontend/src/pages/avocado/AvocadoScouting.tsx` — **create**: scouting wrapper (replaces `AvocadoMap`'s role).
- `frontend/src/pages/avocado/AvocadoObservations.tsx` — **create**: observations wrapper.
- `frontend/src/pages/avocado/AvocadoTraps.tsx` — **create**: traps wrapper.
- `frontend/src/pages/AvocadoMap.tsx` — **delete** (Task 5, once the shell + scouting wrapper replace it).
- `frontend/src/App.tsx` — **modify**: route `observations`/`traps`/`scouting-map` to the avocado wrappers for the avocado crop.

---

## Task 1: Pure per-view derivations + tests

**Files:**
- Create: `frontend/src/pages/avocado/tree-map-types.ts`, `derive-scouts.ts`, `derive-observations.ts`, `derive-traps.ts`, `derive.test.ts`

**Interfaces:**
- Produces:
  - `MarkerPoint { lng, lat, count, color, label? }`, `AvocadoView { title, subtitle, deriveColors, deriveMarkers?, renderPanel, headerControls?, showTracks? }` (in `tree-map-types.ts`).
  - `SCOUT_PALETTE: string[]`, `deriveScoutColors(data): Map<string,string>`, `deriveScoutRoster(data): {key,color,trees}[]`.
  - `deriveObservationColors(data, kind, colorOf): Map<string,string>`, `deriveObservationRoster(data, kind): {name,count}[]`.
  - `severityColor(count): string`, `deriveTrapMarkers(data): MarkerPoint[]`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/avocado/derive.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { ProcessedData } from "@/lib/scouting-types";
import { deriveScoutColors, deriveScoutRoster, SCOUT_PALETTE } from "./derive-scouts";
import { deriveObservationColors, deriveObservationRoster } from "./derive-observations";
import { deriveTrapMarkers, severityColor } from "./derive-traps";

function data(entries: any[]): ProcessedData {
  return { entries, pests: {}, diseases: {}, traps: {}, greenhouses: {}, scouts: {}, daily: {} } as ProcessedData;
}

describe("deriveScoutColors", () => {
  it("tints each visited tree by its scout, palette in first-seen order", () => {
    const d = data([
      { tree: "T1", scouts_name: "A" },
      { tree: "T2", scouts_name: "B" },
      { tree: "T3", scouts_name: "A" },
    ]);
    const m = deriveScoutColors(d);
    expect(m.get("T1")).toBe(SCOUT_PALETTE[0]);
    expect(m.get("T3")).toBe(SCOUT_PALETTE[0]);
    expect(m.get("T2")).toBe(SCOUT_PALETTE[1]);
  });
  it("skips entries without a tree or scout", () => {
    expect(deriveScoutColors(data([{ scouts_name: "A" }, { tree: "T1" }])).size).toBe(0);
  });
  it("rosters scouts by distinct trees, most active first", () => {
    const r = deriveScoutRoster(data([
      { tree: "T1", scouts_name: "A" }, { tree: "T2", scouts_name: "A" }, { tree: "T3", scouts_name: "B" },
    ]));
    expect(r.map((x) => x.key)).toEqual(["A", "B"]);
    expect(r[0].trees).toBe(2);
  });
});

describe("deriveObservationColors", () => {
  const colorOf = (n: string) => (n === "Thrips" ? "#111111" : "#222222");
  it("tints a tree by its dominant pest of the active kind", () => {
    const d = data([
      { tree: "T1", pests_scouting_entry: [{ pest: "Thrips", count: 5 }, { pest: "Mites", count: 1 }], diseases_scouting_entry: [] },
    ]);
    expect(deriveObservationColors(d, "pest", colorOf).get("T1")).toBe("#111111");
  });
  it("honours kind — diseases ignored under pest kind", () => {
    const d = data([{ tree: "T1", pests_scouting_entry: [], diseases_scouting_entry: [{ disease: "Anthracnose" }] }]);
    expect(deriveObservationColors(d, "pest", colorOf).size).toBe(0);
    expect(deriveObservationColors(d, "disease", colorOf).get("T1")).toBe("#222222");
  });
});

describe("deriveTrapMarkers", () => {
  it("aggregates catches per trap at the averaged coordinate, sorted by count", () => {
    const d = data([
      { latitude: 1, longitude: 2, trap_scouting_entry: [{ trap: "TR1", count: 3 }] },
      { latitude: 1.0, longitude: 2.0, trap_scouting_entry: [{ trap: "TR1", count: 7 }] },
      { latitude: 5, longitude: 6, trap_scouting_entry: [{ trap: "TR2", count: 1 }] },
    ]);
    const m = deriveTrapMarkers(d);
    expect(m[0]).toMatchObject({ label: "TR1", count: 10, lng: 2, lat: 1 });
    expect(m[1]).toMatchObject({ label: "TR2", count: 1 });
    expect(m[0].color).toBe(severityColor(10));
  });
  it("drops trap catches with no usable coordinate", () => {
    const d = data([{ latitude: 0, longitude: 0, trap_scouting_entry: [{ trap: "TR1", count: 3 }] }]);
    expect(deriveTrapMarkers(d)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run src/pages/avocado/derive.test.ts`
Expected: FAIL — cannot resolve `./derive-scouts` etc.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/pages/avocado/tree-map-types.ts`:

```typescript
import type { ReactNode } from "react";
import type { ProcessedData } from "@/lib/scouting-types";

/** A point overlay (e.g. a trap catch) drawn over the trees. */
export interface MarkerPoint {
  lng: number;
  lat: number;
  count: number; // drives the sqrt-scaled radius
  color: string;
  label?: string;
}

/** What a view (Scouting / Observations / Traps / …) supplies to the shell. */
export interface AvocadoView {
  title: string;
  subtitle: string;
  /** Per-tree tint from the cached entries. Empty → all trees unscouted. */
  deriveColors: (data: ProcessedData | null) => Map<string, string>;
  /** Optional point overlay (traps). Omit for tree-only views. */
  deriveMarkers?: (data: ProcessedData | null) => MarkerPoint[];
  /** Docked side-panel content. */
  renderPanel: (data: ProcessedData | null) => ReactNode;
  /** Optional controls for MapHeader's rightSlot (e.g. a pest/disease toggle). */
  headerControls?: ReactNode;
  /** Draw the per-scout movement trails layer (scouting only). */
  showTracks?: boolean;
}
```

Create `frontend/src/pages/avocado/derive-scouts.ts`:

```typescript
import type { ProcessedData } from "@/lib/scouting-types";

export const SCOUT_PALETTE = [
  "#2BA6E0", "#E66BAA", "#8466C7", "#E9A23B", "#5BB45D",
  "#3D54B0", "#E63946", "#10b981", "#f97316", "#a855f7",
];

/** tree → the colour of the scout who logged it (first-seen palette order). */
export function deriveScoutColors(data: ProcessedData | null): Map<string, string> {
  const m = new Map<string, string>();
  if (!data) return m;
  const scoutColors = new Map<string, string>();
  for (const e of data.entries) {
    if (!e.tree || !e.scouts_name) continue;
    let col = scoutColors.get(e.scouts_name);
    if (!col) {
      col = SCOUT_PALETTE[scoutColors.size % SCOUT_PALETTE.length];
      scoutColors.set(e.scouts_name, col);
    }
    m.set(e.tree, col);
  }
  return m;
}

export interface ScoutRosterRow {
  key: string;
  color: string;
  trees: number;
}

/** Scouts who logged trees, their colour and distinct trees, most active first. */
export function deriveScoutRoster(data: ProcessedData | null): ScoutRosterRow[] {
  const out: ScoutRosterRow[] = [];
  if (!data) return out;
  const color = new Map<string, string>();
  const trees = new Map<string, Set<string>>();
  for (const e of data.entries) {
    if (!e.tree || !e.scouts_name) continue;
    if (!color.has(e.scouts_name))
      color.set(e.scouts_name, SCOUT_PALETTE[color.size % SCOUT_PALETTE.length]);
    let s = trees.get(e.scouts_name);
    if (!s) {
      s = new Set();
      trees.set(e.scouts_name, s);
    }
    s.add(e.tree);
  }
  for (const [key, col] of color)
    out.push({ key, color: col, trees: trees.get(key)?.size || 0 });
  out.sort((a, b) => b.trees - a.trees || a.key.localeCompare(b.key));
  return out;
}
```

Create `frontend/src/pages/avocado/derive-observations.ts`:

```typescript
import type { ProcessedData } from "@/lib/scouting-types";
import { OBS_DEFAULT_COLOR, type ObsKind } from "@/lib/observation-colors";

/** Observation names of the given kind on one entry, with a count (diseases
 *  carry no count, so each counts once). */
function obsOf(e: ProcessedData["entries"][number], kind: ObsKind): Array<{ name: string; count: number }> {
  if (kind === "pest")
    return (e.pests_scouting_entry || []).map((o) => ({ name: o.pest, count: o.count || 1 }));
  return (e.diseases_scouting_entry || []).map((o) => ({ name: o.disease, count: 1 }));
}

/** tree → canonical colour of its DOMINANT observation of `kind`.
 *  `colorOf` resolves an observation name to a hex (pestColor / diseaseColor). */
export function deriveObservationColors(
  data: ProcessedData | null,
  kind: ObsKind,
  colorOf: (name: string) => string,
): Map<string, string> {
  const m = new Map<string, string>();
  if (!data) return m;
  const perTree = new Map<string, Map<string, number>>();
  for (const e of data.entries) {
    if (!e.tree) continue;
    for (const o of obsOf(e, kind)) {
      if (!o.name) continue;
      let t = perTree.get(e.tree);
      if (!t) {
        t = new Map();
        perTree.set(e.tree, t);
      }
      t.set(o.name, (t.get(o.name) || 0) + o.count);
    }
  }
  for (const [tree, names] of perTree) {
    let best = "";
    let bestN = -1;
    for (const [name, n] of names) if (n > bestN) { bestN = n; best = name; }
    m.set(tree, best ? colorOf(best) : OBS_DEFAULT_COLOR);
  }
  return m;
}

export interface ObsRosterRow {
  name: string;
  count: number;
}

/** Observation names of `kind` with total counts, most frequent first. */
export function deriveObservationRoster(
  data: ProcessedData | null,
  kind: ObsKind,
): ObsRosterRow[] {
  if (!data) return [];
  const totals = new Map<string, number>();
  for (const e of data.entries)
    for (const o of obsOf(e, kind))
      if (o.name) totals.set(o.name, (totals.get(o.name) || 0) + o.count);
  return Array.from(totals, ([name, count]) => ({ name, count })).sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
}
```

Create `frontend/src/pages/avocado/derive-traps.ts`:

```typescript
import type { ProcessedData } from "@/lib/scouting-types";
import type { MarkerPoint } from "./tree-map-types";

// Catch-intensity ramp (matches the rose TrapsMap severity stops).
const SEVERITY_STOPS: Array<[number, string]> = [
  [5, "#fde68a"], [15, "#fcd34d"], [30, "#facc15"], [50, "#fb923c"],
  [75, "#f97316"], [100, "#dc2626"], [Infinity, "#7c2d12"],
];

export function severityColor(count: number): string {
  if (count <= 0) return "#e5e7eb";
  for (const [max, color] of SEVERITY_STOPS) if (count <= max) return color;
  return "#7c2d12";
}

function coord(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** One marker per trap at its averaged coordinate; count = summed catches,
 *  colour = severity of that total. Traps with no usable coordinate are dropped
 *  ((0,0) is the Atlantic → treated as missing). */
export function deriveTrapMarkers(data: ProcessedData | null): MarkerPoint[] {
  if (!data) return [];
  const agg = new Map<string, { latSum: number; lngSum: number; n: number; count: number }>();
  for (const e of data.entries) {
    const lat = coord(e.latitude);
    const lng = coord(e.longitude);
    const hasCoord =
      lat != null && lng != null && !(Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001);
    for (const t of e.trap_scouting_entry || []) {
      if (!t.trap) continue;
      let a = agg.get(t.trap);
      if (!a) {
        a = { latSum: 0, lngSum: 0, n: 0, count: 0 };
        agg.set(t.trap, a);
      }
      a.count += t.count || 0;
      if (hasCoord) {
        a.latSum += lat as number;
        a.lngSum += lng as number;
        a.n++;
      }
    }
  }
  const out: MarkerPoint[] = [];
  for (const [trap, a] of agg) {
    if (!a.n) continue; // no coordinate → can't place it
    out.push({
      lng: a.lngSum / a.n,
      lat: a.latSum / a.n,
      count: a.count,
      color: severityColor(a.count),
      label: trap,
    });
  }
  return out.sort((x, y) => y.count - x.count);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run src/pages/avocado/derive.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/avocado/tree-map-types.ts frontend/src/pages/avocado/derive-scouts.ts frontend/src/pages/avocado/derive-observations.ts frontend/src/pages/avocado/derive-traps.ts frontend/src/pages/avocado/derive.test.ts
git commit -m "feat(avocado): pure per-view derivations for the shared tree map"
```

---

## Task 2: Extract `AvocadoTreeMap` shell + `AvocadoScouting` wrapper

**Files:**
- Create: `frontend/src/pages/avocado/AvocadoTreeMap.tsx` (from `frontend/src/pages/AvocadoMap.tsx`)
- Create: `frontend/src/pages/avocado/AvocadoScouting.tsx`

**Interfaces:**
- Consumes: `AvocadoView`, `MarkerPoint` (Task 1); `deriveScoutColors`, `deriveScoutRoster` (Task 1).
- Produces: `AvocadoTreeMap({ view }: { view: AvocadoView })`; `AvocadoScouting()`.

- [ ] **Step 1: Create `AvocadoTreeMap.tsx` by moving + parameterizing `AvocadoMap.tsx`**

Copy the entire current `frontend/src/pages/AvocadoMap.tsx` to `frontend/src/pages/avocado/AvocadoTreeMap.tsx`, then apply exactly these changes (everything not listed — the blocks/tanks/tree/tracks/fly-to/click effects, `useScouting`, geo fetches, loader, single-farm handling — **moves verbatim**; note the import paths change from `./maps/...` to `../maps/...` and `@/…` stays):

1. **Signature + props.** Rename the component and take the view:
   ```tsx
   import type { AvocadoView, MarkerPoint } from "./tree-map-types";
   export function AvocadoTreeMap({ view }: { view: AvocadoView }) {
   ```
2. **Colours come from the view.** Delete the `SCOUT_PALETTE` const and the `treeColors` / `scoutRoster` / `scoutNames` / `nameOf` memos+state (they move to the scouting wrapper). Replace the `treeColors` memo with:
   ```tsx
   const treeColors = useMemo(() => view.deriveColors(data), [data, view]);
   ```
   Keep the existing `treeCoords` memo (the tracks layer uses it).
3. **Markers overlay.** Add, alongside the other layer effects, a marker circle-layer driven by the view:
   ```tsx
   const markers = useMemo<MarkerPoint[]>(
     () => (view.deriveMarkers ? view.deriveMarkers(data) : []),
     [data, view],
   );
   useEffect(() => {
     const map = mapRef.current;
     if (!map || !mapReady) return;
     const fc = {
       type: "FeatureCollection" as const,
       features: markers.map((m) => ({
         type: "Feature" as const,
         geometry: { type: "Point" as const, coordinates: [m.lng, m.lat] },
         properties: { count: m.count, color: m.color, label: m.label || "" },
       })),
     };
     if (!map.getSource("markers")) {
       map.addSource("markers", { type: "geojson", data: fc });
       map.addLayer({
         id: "markers-circle",
         type: "circle",
         source: "markers",
         paint: {
           // sqrt-scaled radius so heavy traps read bigger without dwarfing the rest
           "circle-radius": ["max", 4, ["*", 2.2, ["sqrt", ["get", "count"]]]],
           "circle-color": ["get", "color"],
           "circle-opacity": 0.85,
           "circle-stroke-color": "#1a1a18",
           "circle-stroke-width": 1,
         },
       });
     } else {
       (map.getSource("markers") as maplibregl.GeoJSONSource).setData(fc);
     }
   }, [markers, mapReady]);
   ```
4. **Tracks become opt-in.** Guard the existing tracks-layer effect body so it only builds when `view.showTracks` is set (add `if (!view.showTracks) return;` at the top of that effect, and keep its existing deps plus `view.showTracks`).
5. **Header + title.** In the `MapHeader`, replace `title="Avocado · 3D"` / `subtitle="…"` with `title={view.title}` / `subtitle={view.subtitle}`, and render the view's controls above the Layers popover:
   ```tsx
   rightSlot={
     <>
       {view.headerControls}
       {/* existing Layers <Popover>…</Popover> stays here */}
     </>
   }
   ```
6. **Panel + legend from the view.** Replace the scout-roster `<aside>` body with `{view.renderPanel(data)}` wrapped in the same `<aside className="hidden lg:flex flex-col …">` container, and keep the top legend bar's Unscouted swatch + `{blockCount} blocks · {treeCount} trees · {scoutedTreeCount} visited` counts (they're view-independent).

- [ ] **Step 2: Create `AvocadoScouting.tsx`**

Create `frontend/src/pages/avocado/AvocadoScouting.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { AvocadoTreeMap } from "./AvocadoTreeMap";
import type { AvocadoView } from "./tree-map-types";
import { deriveScoutColors, deriveScoutRoster } from "./derive-scouts";
import { fetchScoutLookup } from "@/lib/scouting-api";

export function AvocadoScouting() {
  const [scoutNames, setScoutNames] = useState<Record<string, string>>({});
  useEffect(() => {
    fetchScoutLookup().then(setScoutNames);
  }, []);
  const nameOf = (k: string) => scoutNames[k] || k;

  const view = useMemo<AvocadoView>(
    () => ({
      title: "Scouting Map",
      subtitle: "Orchard trees · per-scout coloring · click a block to fly in",
      showTracks: true,
      deriveColors: deriveScoutColors,
      renderPanel: (data) => {
        const roster = deriveScoutRoster(data);
        return (
          <>
            <div className="border-b px-3 py-2.5">
              <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                Scouts
              </div>
            </div>
            <div className="flex-1 min-h-0 space-y-0.5 overflow-y-auto p-2">
              <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ background: "#7c8b6a" }} aria-hidden />
                <span className="flex-1 truncate text-muted-foreground">Unscouted</span>
              </div>
              {roster.length ? (
                roster.map((s) => (
                  <div key={s.key} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ background: s.color }} aria-hidden />
                    <span className="flex-1 truncate" title={nameOf(s.key)}>{nameOf(s.key)}</span>
                    <span className="tabular-nums text-muted-foreground">{s.trees}</span>
                  </div>
                ))
              ) : (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No scouting this week</div>
              )}
            </div>
          </>
        );
      },
    }),
    [scoutNames],
  );

  return <AvocadoTreeMap view={view} />;
}
```

Note: the `<aside>` wrapper (and its footer `N of M trees visited`) lives in the shell; `renderPanel` returns the header + list that go inside it.

- [ ] **Step 3: Build**

Run (from `frontend/`): `yarn build`
Expected: succeeds, no TS errors. (`AvocadoMap.tsx` still exists and is still imported by `App.tsx` — untouched until Task 5, so the build stays green.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/avocado/AvocadoTreeMap.tsx frontend/src/pages/avocado/AvocadoScouting.tsx
git commit -m "feat(avocado): reusable AvocadoTreeMap shell + scouting wrapper"
```

---

## Task 3: `AvocadoObservations` wrapper

**Files:**
- Create: `frontend/src/pages/avocado/AvocadoObservations.tsx`

**Interfaces:**
- Consumes: `AvocadoTreeMap`, `AvocadoView` (Task 2); `deriveObservationColors`, `deriveObservationRoster` (Task 1); `useObservationColors` + `HEADER_PILL`.
- Produces: `AvocadoObservations()`.

- [ ] **Step 1: Create the wrapper**

Create `frontend/src/pages/avocado/AvocadoObservations.tsx`:

```tsx
import { useMemo, useState } from "react";
import { AvocadoTreeMap } from "./AvocadoTreeMap";
import type { AvocadoView } from "./tree-map-types";
import { deriveObservationColors, deriveObservationRoster } from "./derive-observations";
import { useObservationColors, type ObsKind } from "@/lib/observation-colors";
import { HEADER_PILL } from "@/components/header-controls";

export function AvocadoObservations() {
  const [kind, setKind] = useState<ObsKind>("pest");
  const { pest: pestColor, disease: diseaseColor } = useObservationColors();

  const view = useMemo<AvocadoView>(() => {
    const colorOf = (name: string) => (kind === "disease" ? diseaseColor(name) : pestColor(name));
    return {
      title: "Observations",
      subtitle: "Orchard trees · tinted by the dominant pest / disease observed",
      deriveColors: (data) => deriveObservationColors(data, kind, colorOf),
      headerControls: (
        <div className={`${HEADER_PILL} gap-0 overflow-hidden !p-0`}>
          {(["pest", "disease"] as ObsKind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`px-3 py-1 text-xs capitalize ${kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
            >
              {k === "pest" ? "Pests" : "Diseases"}
            </button>
          ))}
        </div>
      ),
      renderPanel: (data) => {
        const roster = deriveObservationRoster(data, kind);
        return (
          <>
            <div className="border-b px-3 py-2.5">
              <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                {kind === "pest" ? "Pests" : "Diseases"}
              </div>
            </div>
            <div className="flex-1 min-h-0 space-y-0.5 overflow-y-auto p-2">
              {roster.length ? (
                roster.map((o) => (
                  <div key={o.name} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ background: colorOf(o.name) }} aria-hidden />
                    <span className="flex-1 truncate" title={o.name}>{o.name}</span>
                    <span className="tabular-nums text-muted-foreground">{o.count}</span>
                  </div>
                ))
              ) : (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No {kind === "pest" ? "pests" : "diseases"} this week</div>
              )}
            </div>
          </>
        );
      },
    };
  }, [kind, pestColor, diseaseColor]);

  return <AvocadoTreeMap view={view} />;
}
```

- [ ] **Step 2: Build**

Run: `yarn build`
Expected: succeeds, no TS errors. (`useObservationColors` returns `{ pest, disease }` resolver fns — confirm by the existing rose `Observations.tsx` usage `const { pest: pestColor, disease: diseaseColor } = useObservationColors();`.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/avocado/AvocadoObservations.tsx
git commit -m "feat(avocado): Observations view on the shared tree map"
```

---

## Task 4: `AvocadoTraps` wrapper

**Files:**
- Create: `frontend/src/pages/avocado/AvocadoTraps.tsx`

**Interfaces:**
- Consumes: `AvocadoTreeMap`, `AvocadoView` (Task 2); `deriveTrapMarkers`, `severityColor` (Task 1).
- Produces: `AvocadoTraps()`.

- [ ] **Step 1: Create the wrapper**

Create `frontend/src/pages/avocado/AvocadoTraps.tsx`:

```tsx
import { useMemo } from "react";
import { AvocadoTreeMap } from "./AvocadoTreeMap";
import type { AvocadoView } from "./tree-map-types";
import { deriveTrapMarkers } from "./derive-traps";

export function AvocadoTraps() {
  const view = useMemo<AvocadoView>(
    () => ({
      title: "Traps",
      subtitle: "Orchard trees · trap catches sized by count",
      // Trees stay plain (unscouted colour); trap catches are the signal.
      deriveColors: () => new Map<string, string>(),
      deriveMarkers: deriveTrapMarkers,
      renderPanel: (data) => {
        const traps = deriveTrapMarkers(data);
        return (
          <>
            <div className="border-b px-3 py-2.5">
              <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                Traps
              </div>
            </div>
            <div className="flex-1 min-h-0 space-y-0.5 overflow-y-auto p-2">
              {traps.length ? (
                traps.map((t) => (
                  <div key={t.label} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ background: t.color }} aria-hidden />
                    <span className="flex-1 truncate" title={t.label}>{t.label}</span>
                    <span className="tabular-nums text-muted-foreground">{t.count}</span>
                  </div>
                ))
              ) : (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No trap catches this week</div>
              )}
            </div>
          </>
        );
      },
    }),
    [],
  );

  return <AvocadoTreeMap view={view} />;
}
```

- [ ] **Step 2: Build**

Run: `yarn build`
Expected: succeeds, no TS errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/avocado/AvocadoTraps.tsx
git commit -m "feat(avocado): Traps view (catch markers) on the shared tree map"
```

---

## Task 5: Route the avocado views + retire `AvocadoMap.tsx`

**Files:**
- Modify: `frontend/src/App.tsx` (lazy imports, `renderView`, PREFETCH)
- Delete: `frontend/src/pages/AvocadoMap.tsx`

**Interfaces:**
- Consumes: `AvocadoScouting`, `AvocadoObservations`, `AvocadoTraps` (Tasks 2–4).

- [ ] **Step 1: Swap the lazy imports**

In `frontend/src/App.tsx`, replace the `AvocadoMap` lazy import with the three avocado wrappers:

```tsx
const AvocadoScouting = lazy(() =>
  import("@/pages/avocado/AvocadoScouting").then((m) => ({ default: m.AvocadoScouting })),
);
const AvocadoObservations = lazy(() =>
  import("@/pages/avocado/AvocadoObservations").then((m) => ({ default: m.AvocadoObservations })),
);
const AvocadoTraps = lazy(() =>
  import("@/pages/avocado/AvocadoTraps").then((m) => ({ default: m.AvocadoTraps })),
);
```

Delete the old `const AvocadoMap = lazy(() => import("@/pages/AvocadoMap")…)` line.

- [ ] **Step 2: Route by crop in `renderView`**

In `renderView`, change the three cases so avocado uses the new wrappers (rose unchanged):

```tsx
    case "observations":
      return crop === "rose"
        ? <Observations initialCrop={cropName} />
        : <AvocadoObservations />;
    case "traps":
      return crop === "rose"
        ? <TrapsMap initialCrop={cropName} />
        : <AvocadoTraps />;
    case "scouting-map":
      return crop === "rose" ? <RoseScouting /> : <AvocadoScouting />;
```

- [ ] **Step 3: Fix PREFETCH**

In the `PREFETCH` array, replace `() => import("@/pages/AvocadoMap")` with the three wrappers:

```tsx
  () => import("@/pages/avocado/AvocadoScouting"),
  () => import("@/pages/avocado/AvocadoObservations"),
  () => import("@/pages/avocado/AvocadoTraps"),
```

- [ ] **Step 4: Delete the old page**

```bash
git rm frontend/src/pages/AvocadoMap.tsx
```

- [ ] **Step 5: Build + verify no dangling refs**

Run (from `frontend/`):
```bash
grep -rn "pages/AvocadoMap\b\|from \"@/pages/AvocadoMap\"" src && echo "DANGLING REF" || echo "no refs to old AvocadoMap"
yarn build
```
Expected: no dangling refs; build succeeds, no TS errors.

- [ ] **Step 6: Deploy + manual verification**

```bash
cd /home/ubuntu/stive/code/frappe15 && bench --site kaitet.local clear-cache
```
Hard-refresh the avocado section and confirm:
- **Scouting Map** — unchanged from before (trees per-scout coloured, scout roster panel, tracks, Lokitela auto-selected). Heading reads "Scouting Map" (no "· 3D").
- **Observations** — trees tinted by dominant pest/disease; the Pests/Diseases toggle flips colours + panel; heading "Observations".
- **Traps** — trees plain; trap catches as sized circle markers; panel lists traps by count; heading "Traps".
- Switching between the three (kept alive) refetches nothing and the map doesn't re-init; rose Observations/Traps still render their Leaflet maps.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(avocado): route Scouting/Observations/Traps to the shared tree map"
```

---

## Self-review notes for the implementer

- The shell keeps the map **3D** — the 2D/gradient "Heat maps" page is a later sub-project that adds a `deriveColors` gradient mode + a top-down camera + planning sidebar on this same shell.
- Do not touch `TreesLayer.ts` — the `{names,coords}`/colour contract is unchanged; the view only changes what `deriveColors` returns.
- `view` objects are memoised in each wrapper so `AvocadoTreeMap`'s `useMemo([data, view])` recomputes colours/markers only when data or view state (e.g. observation kind) actually changes.
- **Known interaction (flag at final review, likely a follow-up):** Scouting / Observations / Traps are three nav items → three keep-alive `AvocadoTreeMap` instances, each its own MapLibre map, once visited. `TreesLayer.render` calls `map.triggerRepaint()` every frame, so hidden avocado maps keep a live render loop (3× wasted GPU when all three have been opened). Out of scope to fix here (don't touch `TreesLayer`), but note it: a lightweight follow-up is to pause repaint / the layer when the keep-alive container is inactive (pass an `active` flag from the `KeepAlive` wrapper down to the shell). Do NOT silently ignore it in the final review.
