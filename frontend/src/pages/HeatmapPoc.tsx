/**
 * Heatmap rendering POC — single-GH and multi-GH modes.
 *
 * URL forms:
 *   #/poc-heatmap?gh=<Greenhouse>&obs=<Name>&kind=pest|disease
 *   #/poc-heatmap?ghs=<GH1>|<GH2>|<GH3>&obs=<Name>&kind=pest|disease
 *
 * The multi-GH form fires all greenhouse fetches in parallel, projects
 * each greenhouse's bed geometry exactly once, and renders one row per
 * greenhouse with its 3-day strip. The whole grid is what the full
 * Heatmaps page will look like; this POC just hard-codes the GH list
 * via the URL so we can profile scaling without building the filter row.
 *
 * Timing logs:
 *   [poc-projection] per-greenhouse projection time
 *   [poc-row]        per-greenhouse fetch+ready time
 *   [poc-grid]       overall: rows, total markers, end-to-end ms
 */

import { useEffect, useMemo, useState } from "react";
import { call } from "@/lib/frappe";
import { fetchBedsAndZones } from "@/lib/scouting-api";
import {
  projectGeometry,
  type ProjectedGeometry,
} from "@/pages/maps/bed-projection";
import { MarkerDefs, type MarkerKind } from "@/pages/maps/MarkerDefs";
import {
  BedSvg,
  markersFromZoneStages,
  type BedMarker,
  type ZoneStage,
} from "@/pages/maps/BedSvg";

interface PocResponse {
  greenhouse: string;
  obsName: string;
  obsKind: "pest" | "disease";
  color: string;
  recent: Array<{
    date: string;
    zoneObs: Record<string, number>;
    zoneStages?: Record<string, ZoneStage[]>;
  }>;
}

interface HashParams {
  ghs: string[];
  obs: string;
  kind: "pest" | "disease";
}

function parseHash(): HashParams {
  const h = window.location.hash || "";
  const q = h.includes("?") ? h.slice(h.indexOf("?") + 1) : "";
  const params = new URLSearchParams(q);
  // Prefer the multi-GH ``ghs=...`` form; fall back to the single ``gh=...``.
  const ghsRaw = params.get("ghs") || params.get("gh") || "";
  const ghs = ghsRaw
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    ghs,
    obs: params.get("obs") || "",
    kind: params.get("kind") === "disease" ? "disease" : "pest",
  };
}

interface RowState {
  greenhouse: string;
  resp?: PocResponse;
  geometry?: ProjectedGeometry;
  err?: string;
  fetch_ms?: number;
  project_ms?: number;
  ready_ms?: number;
}

export function HeatmapPoc() {
  const [params, setParams] = useState(parseHash);
  const [tree, setTree] = useState<
    Array<{
      beds: Array<{
        name: string;
        zones: Array<{
          name: string;
          coords: [[number, number], [number, number]];
          lineId: unknown;
        }>;
      }>;
    }> | null
  >(null);
  const [rows, setRows] = useState<RowState[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [t0, setT0] = useState<number>(0);

  useEffect(() => {
    const onHash = () => setParams(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Fetch the bed/zone tree once (24h-cached client-side).
  useEffect(() => {
    if (!params.ghs.length) return;
    void fetchBedsAndZones()
      .then((t) => setTree(t as any))
      .catch((e) => setErr(e?.message || "geometry fetch failed"));
  }, [params.ghs.length === 0]);

  // Fetch all GHs in parallel whenever the param set changes.
  useEffect(() => {
    if (!params.ghs.length || !params.obs || !tree) return;
    const start = performance.now();
    setT0(start);
    setRows(params.ghs.map((g) => ({ greenhouse: g })));

    params.ghs.forEach((gh, rowIdx) => {
      const rowStart = performance.now();
      void call<{ message?: PocResponse }>(
        "upande_scp.serverscripts.dashboard_aggregates.heatmap_poc",
        { greenhouse: gh, obs_name: params.obs, obs_kind: params.kind },
      )
        .then((raw) => {
          const tFetch = performance.now();
          const resp = (raw as any)?.message ?? (raw as PocResponse);

          // Project this greenhouse's geometry from the cached tree.
          const ghPrefix = gh + " - ";
          const zones: {
            name: string;
            coords: [[number, number], [number, number]];
            lineId: unknown;
          }[] = [];
          for (const v of tree) {
            for (const bed of v.beds || []) {
              if (!bed.name?.startsWith(ghPrefix) && bed.name !== gh) continue;
              for (const z of bed.zones || []) zones.push(z);
            }
          }
          const tProj0 = performance.now();
          const geometry = projectGeometry(zones) || undefined;
          const tProj1 = performance.now();
          const project_ms = +(tProj1 - tProj0).toFixed(1);
          const fetch_ms = +(tFetch - rowStart).toFixed(1);

          requestAnimationFrame(() => {
            const tReady = performance.now();
            const ready_ms = +(tReady - rowStart).toFixed(1);
            console.log("[poc-row]", {
              greenhouse: gh,
              fetch_ms,
              project_ms,
              ready_ms,
              dates: resp?.recent?.length || 0,
              bed_paths: geometry?.beds.length || 0,
              zones: Object.keys(geometry?.zoneCentroids || {}).length,
            });
          });

          setRows((cur) => {
            const next = cur.slice();
            next[rowIdx] = {
              greenhouse: gh,
              resp,
              geometry,
              fetch_ms,
              project_ms,
            };
            return next;
          });
        })
        .catch((e) =>
          setRows((cur) => {
            const next = cur.slice();
            next[rowIdx] = {
              greenhouse: gh,
              err: e?.message || "fetch failed",
            };
            return next;
          }),
        );
    });
  }, [params.ghs.join("|"), params.obs, params.kind, tree]);

  // When every row has either landed or errored, emit the grid summary.
  const allDone = rows.length > 0 && rows.every((r) => r.resp || r.err);
  useEffect(() => {
    if (!allDone || !t0) return;
    requestAnimationFrame(() => {
      const tEnd = performance.now();
      const successful = rows.filter((r) => r.resp);
      const totalMarkers = successful.reduce(
        (s, r) =>
          s +
          (r.resp?.recent || []).reduce(
            (a, d) => a + Object.keys(d.zoneObs).length,
            0,
          ),
        0,
      );
      console.log("[poc-grid]", {
        rows: rows.length,
        ok: successful.length,
        errors: rows.length - successful.length,
        total_markers: totalMarkers,
        end_to_end_ms: +(tEnd - t0).toFixed(1),
      });
    });
  }, [allDone, t0, rows]);

  if (!params.ghs.length || !params.obs) {
    return (
      <div className="p-8 text-sm">
        <p className="font-medium mb-2">Heatmap rendering POC</p>
        <p className="text-muted-foreground mb-3">
          Open with hash params:
        </p>
        <ul className="text-muted-foreground space-y-1 ml-4 list-disc">
          <li>
            Single: <code>#/poc-heatmap?gh=&lt;GH&gt;&amp;obs=&lt;Name&gt;&amp;kind=pest|disease</code>
          </li>
          <li>
            Multi: <code>#/poc-heatmap?ghs=&lt;GH1&gt;|&lt;GH2&gt;|&lt;GH3&gt;&amp;obs=&lt;Name&gt;&amp;kind=pest|disease</code>
          </li>
        </ul>
      </div>
    );
  }

  if (err) {
    return <div className="p-8 text-sm text-[var(--sd-data-red)]">Error: {err}</div>;
  }

  const kind: MarkerKind = params.kind === "disease" ? "disease" : "pest";

  return (
    <div className="p-4 md:p-6 flex flex-col gap-4">
      <MarkerDefs />
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-semibold">
            {params.ghs.length} greenhouse{params.ghs.length === 1 ? "" : "s"} · {params.obs}
          </h1>
          <p className="text-xs text-muted-foreground">
            Open DevTools console for timing logs: [poc-row], [poc-grid]
          </p>
        </div>
      </header>

      <div className="flex flex-col gap-3">
        {rows.map((r, rowIdx) => {
          if (r.err) {
            return (
              <div
                key={rowIdx}
                className="border rounded-md p-3 text-xs text-[var(--sd-data-red)]"
              >
                {r.greenhouse}: {r.err}
              </div>
            );
          }
          if (!r.resp || !r.geometry) {
            return (
              <div
                key={rowIdx}
                className="border rounded-md p-3 text-xs text-muted-foreground"
              >
                Loading {r.greenhouse}…
              </div>
            );
          }
          const resp = r.resp;
          const geom = r.geometry;
          return (
            <div key={rowIdx} className="border rounded-md p-3 bg-card flex flex-col gap-2">
              <div className="flex items-baseline justify-between flex-wrap gap-2">
                <div>
                  <h2 className="text-sm font-medium">{resp.greenhouse}</h2>
                  <p className="text-[10px] text-muted-foreground">
                    {geom.beds.length} beds · {Object.keys(geom.zoneCentroids).length} zones · {resp.recent.length} scouting dates
                  </p>
                </div>
                <p className="text-[10px] tabular-nums text-muted-foreground">
                  fetch {r.fetch_ms}ms · project {r.project_ms}ms
                </p>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
                {resp.recent.length === 0 ? (
                  <div className="col-span-3 text-xs text-muted-foreground p-4 border rounded-md bg-[var(--sd-bg-soft)]">
                    No {params.obs} entries in {resp.greenhouse} in the last 90 days.
                  </div>
                ) : (
                  resp.recent.map((day, i) => {
                    const markers: BedMarker[] = day.zoneStages
                      ? markersFromZoneStages(day.zoneStages, resp.color)
                      : Object.entries(day.zoneObs).map(([zone, count]) => ({
                          zone,
                          count,
                          kind,
                          color: resp.color,
                        }));
                    return (
                      <div key={day.date} className="flex flex-col gap-1 border rounded-md bg-[var(--sd-bg-soft)] p-2">
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="font-medium">{day.date}</span>
                          <span className="text-muted-foreground tabular-nums">
                            {markers.length}z
                          </span>
                        </div>
                        <BedSvg
                          geometry={geom}
                          markers={markers}
                          className="w-full h-auto"
                        />
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
