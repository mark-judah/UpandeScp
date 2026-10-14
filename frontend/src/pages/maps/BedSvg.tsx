/**
 * Static-bed-paths + instanced-marker SVG renderer.
 *
 * Bed paths render once per panel as `<path>` elements. Bed labels sit
 * inside a left-gutter column so they don't overlap interior bed lines.
 * Markers come from a shared symbol library (``MarkerDefs``) and slot in
 * via `<use href="#scp-m-*">`.
 */

import { useId, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import { levelOf, paperFor, softFill } from "@/lib/heat-style";
import type { ProjectedGeometry } from "@/pages/maps/bed-projection";
import { convexHull, outlinePath, type Pt } from "@/lib/hull";
import {
  MARKER_ID,
  shapeForKind,
  iconKeyToShape,
  type MarkerKind,
  type MarkerShape,
} from "@/pages/maps/MarkerDefs";

/** One per-stage observation in a zone, as returned by the heatmap endpoints
 *  (``zoneStages``). ``icon_key`` is the Stage catalog's shape name. */
export interface ZoneStage {
  stage: string;
  icon_key: string;
  count: number;
}

/** Build stage-shaped markers from a ``zoneStages`` map: one marker per
 *  (zone, stage), shaped by the stage's catalog icon_key (same stage → same
 *  shape across every pest), coloured by the observation's legend colour. */
export function markersFromZoneStages(
  zoneStages: Record<string, ZoneStage[]> | undefined | null,
  color: string,
): BedMarker[] {
  if (!zoneStages) return [];
  const out: BedMarker[] = [];
  for (const [zone, stages] of Object.entries(zoneStages)) {
    for (const s of stages) {
      out.push({
        zone,
        count: s.count,
        color,
        shape: iconKeyToShape(s.icon_key),
        stage: s.stage,
      });
    }
  }
  return out;
}

export interface BedMarker {
  zone: string;
  count?: number;
  /** Either pass an explicit ``shape`` (stage-driven, e.g. triangle for
   *  Larva) or fall back to ``kind`` (pest = circle, disease = triangle). */
  kind?: MarkerKind;
  shape?: MarkerShape;
  /** Stroke colour — derived from the pest / disease doctype. Markers
   *  are outlined (no fill) so overlapping markers stay distinguishable. */
  color: string;
  /** Stage label used in the tooltip. */
  stage?: string;
}

/** A patch or pin outline: the hull of its zones' centroids, or explicit
 *  points in SVG space. Stroke only — never a fill over the markers. */
export interface BedOverlay {
  id: string;
  zones?: string[];
  points?: Pt[];
  tone: "patch" | "pin";
  label?: string;
}

const OVERLAY_COLOR: Record<BedOverlay["tone"], string> = {
  patch: "var(--sd-data-red)",
  pin: "var(--sd-data-purple)",
};

function overlayPoints(o: BedOverlay, centroids: ProjectedGeometry["zoneCentroids"]): Pt[] {
  if (o.points) return o.points;
  const out: Pt[] = [];
  for (const z of o.zones ?? []) {
    const c = centroids[z];
    if (c) out.push([c.cx, c.cy]);
  }
  return out;
}

/** Client → SVG user space; the raw client point where the browser (or jsdom)
 *  has no screen CTM. */
function svgPoint(e: ReactMouseEvent<SVGSVGElement>): Pt {
  const svg = e.currentTarget;
  const ctm = typeof svg.getScreenCTM === "function" ? svg.getScreenCTM() : null;
  if (ctm && typeof svg.createSVGPoint === "function") {
    const p = svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const q = p.matrixTransform(ctm.inverse());
    return [q.x, q.y];
  }
  return [e.clientX, e.clientY];
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
  /** Only label every Nth bed (in bed-id order) so the gutter doesn't
   *  turn into a column of overlapping numbers. ``1`` = label every bed.
   *  Beds whose ID doesn't parse as a number are always labeled. */
  labelEvery?: number;
  className?: string;
  /** Patch / pin outlines drawn over the markers (spread spec C5). */
  overlays?: BedOverlay[];
  /** The area being drawn, in SVG space; null/undefined when not drawing. */
  draft?: Pt[] | null;
  onCanvasClick?: (pt: Pt) => void;
  onCanvasDoubleClick?: () => void;
}

function shouldLabel(bedId: string, every: number): boolean {
  if (every <= 1) return true;
  const n = parseInt(bedId, 10);
  if (!Number.isFinite(n)) return true;
  // Mark 1, 1+every, 1+2*every, … (so the first bed is always labeled).
  return (n - 1) % every === 0;
}

// Theme tokens (index.css) with light fallbacks: hairline dotted beds, muted
// numbers, a dark neutral for the stage glyphs.
const STROKE_COLOR = "var(--heat-bed, rgba(10,10,10,0.5))";
const LABEL_COLOR = "var(--heat-label, rgba(10,10,10,0.6))";
const GLYPH_COLOR = "var(--heat-glyph, #3a3a34)";

export function BedSvg({
  geometry,
  markers,
  markerSize = 5.5,
  labelFontSize = 3.6,
  labelEvery = 7,
  className,
  overlays,
  draft,
  onCanvasClick,
  onCanvasDoubleClick,
}: BedSvgProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const featherId = `scp-feather-${uid}`;
  const paper = paperFor();

  // One soft blob per (zone, colour): level follows the summed count, so a
  // zone with several stages reads as one deeper patch, not stacked outlines.
  const blobs = useMemo(() => {
    const acc = new Map<string, { zone: string; color: string; count: number }>();
    for (const m of markers) {
      const k = `${m.zone}|${m.color}`;
      const cur = acc.get(k);
      const n = typeof m.count === "number" && m.count > 0 ? m.count : 1;
      if (cur) cur.count += n;
      else acc.set(k, { zone: m.zone, color: m.color, count: n });
    }
    return [...acc.values()];
  }, [markers]);

  // Bed spacing (median gap between neighbouring bed rows) sets swash thickness.
  const swashW = useMemo(() => {
    const ys = geometry.beds.map((b) => b.labelY).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < ys.length; i++) {
      const g = ys[i] - ys[i - 1];
      if (g > 0.05) gaps.push(g);
    }
    gaps.sort((a, b) => a - b);
    const spacing = gaps.length ? gaps[Math.floor(gaps.length / 2)] : markerSize * 1.2;
    return Math.max(markerSize * 0.4, Math.min(markerSize * 1.4, spacing * 0.45));
  }, [geometry.beds, markerSize]);

  return (
    <svg
      viewBox={geometry.viewBox}
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid meet"
      className={className}
      onClick={onCanvasClick ? (e) => onCanvasClick(svgPoint(e)) : undefined}
      onDoubleClick={onCanvasDoubleClick ? () => onCanvasDoubleClick() : undefined}
      style={draft ? { cursor: "crosshair" } : undefined}
    >
      <defs>
        <filter id={featherId} filterUnits="userSpaceOnUse" x="-20" y="-20" width="2000" height="2000">
          <feGaussianBlur stdDeviation={`${markerSize * 0.3} ${swashW * 0.18}`} />
        </filter>
      </defs>
      {/* Bed line layer. */}
      <g>
        {geometry.beds.map((b) => (
          <path
            key={b.bedId}
            d={b.d}
            fill="none"
            stroke={STROKE_COLOR}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            data-testid="bed-line"
          />
        ))}
      </g>

      {/* Bed labels — anchored to the left of each bed's leftmost point.
          For most layouts that lands in the gutter; for interior beds it
          may overlap the line itself (we'll fix in the full migration by
          porting the upright-svg label-slot system, but for the POC having
          *any* visible numbers beats a perfect layout). */}
      <g>
        {geometry.beds
          .filter((b) => shouldLabel(b.bedId, labelEvery))
          .map((b) => (
            <text
              key={b.bedId}
              x={b.labelX}
              y={b.labelY}
              fontSize={labelFontSize}
              textAnchor="end"
              dominantBaseline="middle"
              fill={LABEL_COLOR}
              fontFamily="var(--sd-font)"
            >
              {b.bedId}
            </text>
          ))}
      </g>

      {/* Swashes: a soft stroke along the bed through each zone, in the target
          colour; depth follows level. One blur for the whole group. */}
      <g filter={`url(#${featherId})`} data-testid="heat-blobs">
        {blobs.map((bl) => {
          const c = geometry.zoneCentroids[bl.zone];
          if (!c) return null;
          const seg = geometry.zoneSegments?.[bl.zone];
          const half = markerSize * 1.7;
          const x0 = seg ? seg.x0 : c.cx - half;
          const y0 = seg ? seg.y0 : c.cy;
          const x1 = seg ? seg.x1 : c.cx + half;
          const y1 = seg ? seg.y1 : c.cy;
          return (
            <line
              key={`${bl.zone}|${bl.color}`}
              x1={x0}
              y1={y0}
              x2={x1}
              y2={y1}
              stroke={softFill(bl.color, levelOf(bl.count), paper)}
              strokeWidth={swashW}
              strokeLinecap="round"
            />
          );
        })}
      </g>

      {/* Stage glyphs: small outlined monochrome marks, shape = life stage. */}
      <g opacity={0.75}>
        {markers.map((m, i) => {
          const c = geometry.zoneCentroids[m.zone];
          if (!c) return null;
          const shape =
            m.shape || (m.kind ? shapeForKind(m.kind) : "circle");
          const ref = MARKER_ID[shape];
          const g = markerSize * 0.7;
          return (
            <use
              key={`${m.zone}-${i}-${shape}`}
              href={`#${ref}`}
              x={c.cx - g / 2}
              y={c.cy - g / 2}
              width={g}
              height={g}
              stroke={GLYPH_COLOR}
              strokeWidth={0.5}
              fill="none"
            >
              <title>
                {m.zone}
                {m.stage ? ` · ${m.stage}` : ""}
                {typeof m.count === "number" && m.count > 0
                  ? ` · ${m.count}`
                  : ""}
              </title>
            </use>
          );
        })}
      </g>

      {/* Patch and pin outlines (spread spec C5): stroke only, on top. */}
      {overlays?.length ? (
        <g data-testid="bed-overlays" fill="none">
          {overlays.map((o) => {
            const hull = convexHull(overlayPoints(o, geometry.zoneCentroids));
            if (!hull.length) return null;
            const common = {
              stroke: OVERLAY_COLOR[o.tone],
              strokeWidth: o.tone === "pin" ? 0.9 : 1.2,
              strokeDasharray: o.tone === "pin" ? "2.5 1.5" : undefined,
              strokeLinejoin: "round" as const,
              strokeLinecap: "round" as const,
              fill: "none",
            };
            return hull.length === 1 ? (
              <circle key={o.id} data-testid={`overlay-${o.id}`} cx={hull[0][0]} cy={hull[0][1]} r={markerSize} {...common}>
                <title>{o.label}</title>
              </circle>
            ) : (
              <path key={o.id} data-testid={`overlay-${o.id}`} d={outlinePath(hull)} {...common}>
                <title>{o.label}</title>
              </path>
            );
          })}
        </g>
      ) : null}

      {/* The area being drawn (C10). */}
      {draft && draft.length ? (
        <g data-testid="draw-draft" data-vertices={draft.length} fill="none">
          <polyline
            points={draft.map((p) => `${p[0]},${p[1]}`).join(" ")}
            stroke="var(--sd-data-purple)"
            strokeWidth={0.9}
            strokeDasharray="2 1.5"
          />
          {draft.map((p, i) => (
            <circle key={i} cx={p[0]} cy={p[1]} r={1.2} stroke="var(--sd-data-purple)" strokeWidth={0.6} />
          ))}
        </g>
      ) : null}
    </svg>
  );
}
