/**
 * Static-bed-paths + instanced-marker SVG renderer.
 *
 * Bed paths render once per panel as `<path>` elements. Bed labels sit
 * inside a left-gutter column so they don't overlap interior bed lines.
 * Markers come from a shared symbol library (``MarkerDefs``) and slot in
 * via `<use href="#scp-m-*">`.
 */

import type { ProjectedGeometry } from "@/pages/maps/bed-projection";
import { MARKER_ID, type MarkerKind } from "@/pages/maps/MarkerDefs";

export interface BedMarker {
  zone: string;
  count?: number;
  kind: MarkerKind;
  color: string;
}

export interface BedSvgProps {
  geometry: ProjectedGeometry;
  markers: BedMarker[];
  /** Marker size in viewport units (the marker symbols use a centered
   *  10x10 viewBox so this maps 1:1 to the on-screen marker width). */
  markerSize?: number;
  /** Bed-label font size in viewport units. Default is sized to be
   *  legible at the typical card width. */
  labelFontSize?: number;
  className?: string;
}

const STROKE_COLOR = "rgba(0,0,0,0.55)";
const LABEL_COLOR = "rgba(0,0,0,0.7)";

export function BedSvg({
  geometry,
  markers,
  markerSize = 10,
  labelFontSize = 12,
  className,
}: BedSvgProps) {
  return (
    <svg
      viewBox={geometry.viewBox}
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid meet"
      className={className}
    >
      {/* Bed line layer. */}
      <g>
        {geometry.beds.map((b) => (
          <path
            key={b.bedId}
            d={b.d}
            fill="none"
            stroke={STROKE_COLOR}
            strokeWidth={0.9}
          />
        ))}
      </g>

      {/* Bed labels — anchored to the left of each bed's leftmost point.
          For most layouts that lands in the gutter; for interior beds it
          may overlap the line itself (we'll fix in the full migration by
          porting the upright-svg label-slot system, but for the POC having
          *any* visible numbers beats a perfect layout). */}
      <g>
        {geometry.beds.map((b) => (
          <text
            key={b.bedId}
            x={b.labelX}
            y={b.labelY}
            fontSize={labelFontSize}
            textAnchor="end"
            dominantBaseline="middle"
            fill={LABEL_COLOR}
            fontFamily="ui-sans-serif, system-ui, sans-serif"
          >
            {b.bedId}
          </text>
        ))}
      </g>

      {/* Marker layer. */}
      <g>
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
                {typeof m.count === "number" && m.count > 0
                  ? ` · ${m.count}`
                  : ""}
              </title>
            </use>
          );
        })}
      </g>
    </svg>
  );
}
