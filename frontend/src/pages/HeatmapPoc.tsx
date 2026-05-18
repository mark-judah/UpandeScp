/**
 * Heatmap rendering POC.
 *
 * Standalone route to measure the bed-symbol-instance rendering approach
 * end-to-end. Reads target params from ``window.location.hash`` (so the
 * URL can be shared without any React router changes), fetches geometry
 * via the existing ``fetchBedsAndZones`` cache + observations via the new
 * ``heatmap_poc`` endpoint, then renders three panels with shared bed
 * paths and per-day marker layers.
 *
 * Times four numbers to ``console.log("[poc-timing]", …)``:
 *   fetch_ms       — network round-trip for the obs endpoint
 *   parse_ms       — JSON.parse on the response body
 *   project_ms     — equirectangular projection + bed-path emit
 *   full_ready_ms  — request sent → first frame painted with panels
 *
 * URL: ``/scp_app#poc-heatmap?gh=<Greenhouse>&obs=<Name>&kind=pest|disease``
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { call } from "@/lib/frappe";
import { fetchBedsAndZones } from "@/lib/scouting-api";
import {
  projectGeometry,
  type ProjectedGeometry,
} from "@/pages/maps/bed-projection";
import { MarkerDefs, type MarkerKind } from "@/pages/maps/MarkerDefs";
import { BedSvg, type BedMarker } from "@/pages/maps/BedSvg";

interface PocResponse {
  greenhouse: string;
  obsName: string;
  obsKind: "pest" | "disease";
  color: string;
  recent: Array<{ date: string; zoneObs: Record<string, number> }>;
}

function parseHash(): { gh: string; obs: string; kind: "pest" | "disease" } {
  const h = window.location.hash || "";
  const q = h.includes("?") ? h.slice(h.indexOf("?") + 1) : "";
  const params = new URLSearchParams(q);
  return {
    gh: params.get("gh") || "",
    obs: params.get("obs") || "",
    kind: (params.get("kind") === "disease" ? "disease" : "pest") as
      | "pest"
      | "disease",
  };
}

export function HeatmapPoc() {
  const [params, setParams] = useState(parseHash);
  const [resp, setResp] = useState<PocResponse | null>(null);
  const [zoneRows, setZoneRows] = useState<{ name: string; raw_geojson?: string }[] | null>(
    null,
  );
  const [err, setErr] = useState<string | null>(null);
  const fetchStartRef = useRef<number>(0);

  // Re-read hash when it changes (so manually editing the URL refreshes).
  useEffect(() => {
    const onHash = () => setParams(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Fetch zone geometry once. Uses the shared 24h-cached path.
  useEffect(() => {
    if (!params.gh) return;
    void fetchBedsAndZones()
      .then((tree) => {
        // VarietyNode[] → BedZoneNode[] flatten — we only need the zones
        // attached to the matching greenhouse. Bed names contain the
        // greenhouse as prefix (e.g. "Karen GH 1 - Bed 3"), so a startsWith
        // match captures every bed under this greenhouse regardless of
        // variety nesting.
        const ghPrefix = params.gh + " - ";
        const zones: { name: string; raw_geojson?: string }[] = [];
        for (const v of tree) {
          for (const bed of v.beds || []) {
            if (!bed.name?.startsWith(ghPrefix) && bed.name !== params.gh) continue;
            for (const z of bed.zones || []) zones.push(z);
          }
        }
        setZoneRows(zones);
      })
      .catch((e) => setErr(e?.message || "geometry fetch failed"));
  }, [params.gh]);

  // Fetch observations whenever (gh, obs, kind) changes. Time the round-trip.
  useEffect(() => {
    if (!params.gh || !params.obs) return;
    setErr(null);
    setResp(null);
    const t0 = performance.now();
    fetchStartRef.current = t0;
    void call<{ message?: PocResponse }>(
      "upande_scp.serverscripts.dashboard_aggregates.heatmap_poc",
      { greenhouse: params.gh, obs_name: params.obs, obs_kind: params.kind },
    )
      .then((raw) => {
        const tFetch = performance.now();
        const payload = (raw as any)?.message ?? (raw as PocResponse);
        const tParse = performance.now();
        // (Frappe already JSON.parsed via fetch.json(); ``parse_ms`` here
        // is the time we spend reaching into ``.message`` and shallow-
        // checking the response, sub-millisecond — log anyway for
        // completeness.)
        setResp(payload);
        // Defer the full-ready stamp to the next animation frame so
        // we measure after React commits and the browser paints.
        requestAnimationFrame(() => {
          const tReady = performance.now();
          console.log("[poc-timing]", {
            fetch_ms: +(tFetch - t0).toFixed(1),
            parse_ms: +(tParse - tFetch).toFixed(2),
            full_ready_ms: +(tReady - t0).toFixed(1),
            greenhouse: params.gh,
            obs: params.obs,
            kind: params.kind,
            dates: payload?.recent?.length || 0,
          });
        });
      })
      .catch((e) => setErr(e?.message || "obs fetch failed"));
  }, [params.gh, params.obs, params.kind]);

  // Project geometry once per zone-array reference. Time the projection.
  const projected = useMemo<ProjectedGeometry | null>(() => {
    if (!zoneRows || !zoneRows.length) return null;
    const t0 = performance.now();
    const g = projectGeometry(zoneRows);
    const t1 = performance.now();
    console.log("[poc-projection]", {
      project_ms: +(t1 - t0).toFixed(1),
      bed_paths: g?.beds.length || 0,
      zones: Object.keys(g?.zoneCentroids || {}).length,
    });
    return g;
  }, [zoneRows]);

  if (!params.gh || !params.obs) {
    return (
      <div className="p-8 text-sm">
        <p className="font-medium mb-2">Heatmap rendering POC</p>
        <p className="text-muted-foreground mb-3">
          Open this route with hash params: <code>#poc-heatmap?gh=&lt;Greenhouse&gt;&amp;obs=&lt;Name&gt;&amp;kind=pest|disease</code>
        </p>
        <p className="text-muted-foreground">
          Example:{" "}
          <code>#poc-heatmap?gh=Karen GH 1&amp;obs=Thrips&amp;kind=pest</code>
        </p>
      </div>
    );
  }

  if (err) {
    return <div className="p-8 text-sm text-[var(--sd-data-red)]">Error: {err}</div>;
  }

  if (!projected || !resp) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        Loading {params.gh} · {params.obs} ({params.kind})…
      </div>
    );
  }

  const kind: MarkerKind =
    params.kind === "disease" ? "disease" : "pest";

  return (
    <div className="p-4 md:p-6 flex flex-col gap-4">
      <MarkerDefs />
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-semibold">
            {resp.greenhouse} · {resp.obsName}
          </h1>
          <p className="text-xs text-muted-foreground">
            {resp.recent.length} scouting dates · {projected.beds.length} beds ·{" "}
            {Object.keys(projected.zoneCentroids).length} zones
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          Open dev-tools console for timing logs (search "[poc-timing]")
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {resp.recent.length === 0 && (
          <div className="col-span-3 text-sm text-muted-foreground p-8 border rounded-md bg-[var(--sd-bg-soft)]">
            No scouting entries for {resp.obsName} in {resp.greenhouse} in the
            last 90 days.
          </div>
        )}
        {resp.recent.map((day, i) => {
          const markers: BedMarker[] = Object.entries(day.zoneObs).map(
            ([zone, count]) => ({
              zone,
              count,
              kind,
              color: resp.color,
            }),
          );
          return (
            <div key={day.date} className="flex flex-col gap-1 border rounded-md bg-card p-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">{day.date}</span>
                <span className="text-muted-foreground tabular-nums">
                  {markers.length} zone{markers.length === 1 ? "" : "s"}
                </span>
              </div>
              <BedSvg
                geometry={projected}
                markers={markers}
                defsId={`poc-${i}`}
                className="w-full h-auto"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
