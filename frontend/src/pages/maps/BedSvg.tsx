/**
 * Static-bed-paths + instanced-marker SVG renderer.
 *
 * Receives a projected ``ProjectedGeometry`` (one path per bed, plus zone
 * centroids) and a list of markers. Renders one ``<svg>`` whose ``<defs>``
 * holds the bed paths once and an outer ``<use>`` references them — so
 * three panels rendered against the same geometry incur the bed-line cost
 * exactly once, with only the marker ``<use>`` instances differing per
 * panel.
 *
 * Pair with ``<MarkerDefs />`` rendered once at the page root for the
 * actual symbol shapes.
 */

import { useMemo } from "react";
import type { ProjectedGeometry } from "@/pages/maps/bed-projection";
import { MARKER_ID, type MarkerKind } from "@/pages/maps/MarkerDefs";

export interface BedMarker {
  /** Zone name — used to look up cx/cy in ``geometry.zoneCentroids``. */
  zone: string;
  /** Observation count for the zone on this panel's date — shows up in
   *  the ``<title>`` tooltip, doesn't change the marker's size. */
  count?: number;
  kind: MarkerKind;
  color: string;
}

export interface BedSvgProps {
  geometry: ProjectedGeometry;
  markers: BedMarker[];
  /** Stable per-page id prefix used in the ``<defs>`` bed-path IDs so
   *  multiple BedSvgs in the same DOM don't collide. */
  defsId: string;
  /** Marker size in viewport units. 10 = 10×10 box centered on cx/cy. */
  markerSize?: number;
  className?: string;
}

export function BedSvg({
  geometry,
  markers,
  defsId,
  markerSize = 10,
  className,
}: BedSvgProps) {
  // Bed-path IDs live only inside this svg root. Memoise so the same
  // geometry doesn't rebuild the defs string each render.
  const bedSymbol = useMemo(() => {
    const parts: string[] = [];
    for (const b of geometry.beds) {
      parts.push(
        `<path d="${b.d}" fill="none" stroke="rgba(0,0,0,0.45)" stroke-width="0.7" />`,
      );
      // Bed-id label hugs the leftmost point of each bed. Tiny font so a
      // 30-greenhouse grid stays legible without overlapping the line.
      const safe = String(b.bedId)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;");
      parts.push(
        `<text x="${b.labelX.toFixed(2)}" y="${b.labelY.toFixed(2)}" ` +
        `font-size="3.5" text-anchor="end" dominant-baseline="middle" ` +
        `fill="rgba(0,0,0,0.55)" font-family="var(--sd-font, sans-serif)">${safe}</text>`,
      );
    }
    return `<g id="${defsId}-beds">${parts.join("")}</g>`;
  }, [geometry, defsId]);

  return (
    <svg
      viewBox={geometry.viewBox}
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid meet"
      className={className}
    >
      <defs dangerouslySetInnerHTML={{ __html: bedSymbol }} />

      {/* One <use> per panel reaches into the cached <g> for the beds.
          The browser draws those paths once and references them by ID. */}
      <use href={`#${defsId}-beds`} />

      {/* Marker layer — instanced via <use href="#m-..."> for the shape
          and positioned by per-instance x/y. */}
      {markers.map((m, i) => {
        const c = geometry.zoneCentroids[m.zone];
        if (!c) return null;
        const ref = MARKER_ID[m.kind];
        return (
          <use
            key={`${m.zone}-${i}`}
            href={`#${ref}`}
            x={c.cx - markerSize / 2}
            y={c.cy - markerSize / 2}
            width={markerSize}
            height={markerSize}
            fill={m.color}
          >
            <title>
              {m.zone}
              {typeof m.count === "number" && m.count > 0 ? ` · ${m.count}` : ""}
            </title>
          </use>
        );
      })}
    </svg>
  );
}
