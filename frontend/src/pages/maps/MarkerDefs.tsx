/**
 * Shared marker symbol library for the heatmaps and POC.
 *
 * Two encoding axes:
 *   * **colour** identifies the pest / disease (taken from the doctype's
 *     legend hex — same source the Trends page uses).
 *   * **shape**  identifies the life-stage (Adult, Larva, Nymph, Eggs…).
 *     Filled shapes were dropped in favour of outlined symbols so two
 *     markers stacked on the same zone don't bleed into a single blob.
 *
 * Each ``<symbol>`` uses the shared icon's centred 24×24 viewBox, so a
 * ``<use href="#scp-m-X" x={cx - s/2} y={cy - s/2} width={s} height={s} />``
 * lands with the marker centred at (cx, cy). The caller passes ``stroke``
 * and ``fill`` (the legend colour; ``none`` for line shapes).
 */

import { sharedIconsOf } from "@/components/SharedIcon";

const STAGE_ICONS = sharedIconsOf("stage");

export const MARKER_ID = {
  circle:   "scp-m-circle",   // default / no stage
  triangle: "scp-m-triangle",
  pentagon: "scp-m-pentagon",
  diamond:  "scp-m-diamond",  // tilted square
  cross:    "scp-m-cross",    // X
  plus:     "scp-m-plus",     // +
  square:   "scp-m-square",
  hexagon:  "scp-m-hexagon",
  star:     "scp-m-star",
  chevron:  "scp-m-chevron",  // ^ (line shape)
} as const;

export type MarkerShape = keyof typeof MARKER_ID;

/** Resolve a Stage catalog ``icon_key`` (which IS a shape name) to a marker
 * shape. Unknown / empty keys fall back to circle, so the heatmap always
 * renders something even for a stage whose icon_key wasn't curated yet. */
export function iconKeyToShape(iconKey: string | null | undefined): MarkerShape {
  const k = (iconKey || "").trim().toLowerCase();
  return ((k in MARKER_ID ? k : "circle")) as MarkerShape;
}

/** Outline-only shapes (stroke, no fill); the rest are filled with the
 * observation's legend colour. */
export function isLineShape(shape: MarkerShape): boolean {
  return shape === "cross" || shape === "plus" || shape === "chevron";
}

// Back-compat aliases — callers that still think in pest/disease/etc.
// pass a ``MarkerKind`` and we resolve it to a default shape here.
export type MarkerKind = "pest" | "disease" | "trap" | "fcm";

const KIND_TO_SHAPE: Record<MarkerKind, MarkerShape> = {
  pest:    "circle",
  disease: "triangle",
  trap:    "diamond",
  fcm:     "pentagon",
};

export function shapeForKind(kind: MarkerKind): MarkerShape {
  return KIND_TO_SHAPE[kind] ?? "circle";
}

/** Stage → shape, by case-insensitive substring match. Unknown stages
 * fall back to circle. Keeps the mapping in code (instead of the
 * doctype) so adding a stage in Frappe doesn't require a UI change to
 * still render something. */
export function shapeForStage(stage: string | null | undefined): MarkerShape {
  const s = (stage || "").toLowerCase();
  if (!s) return "circle";
  if (s.includes("adult")) return "circle";
  if (s.includes("larv"))  return "triangle";
  if (s.includes("nymph")) return "pentagon";
  if (s.includes("egg"))   return "diamond";
  if (s.includes("pupa"))  return "plus";
  if (s.includes("instar"))return "cross";
  return "circle";
}

export function MarkerDefs() {
  // The shapes come from the one shared icon set
  // (upande_scp/shared/icons/stage/<key>.svg, item 9b). Each carries its own
  // hairline / line stroke width with ``non-scaling-stroke`` so dense maps
  // don't get smudgy as the SVG zooms; fill and stroke colour are left to the
  // caller's ``<use>`` (the pest's legend colour). Line shapes (cross, plus,
  // chevron) set ``fill="none"`` themselves.
  return (
    <svg
      width={0}
      height={0}
      aria-hidden="true"
      style={{ position: "absolute" }}
    >
      <defs>
        {(Object.keys(MARKER_ID) as MarkerShape[]).map((shape) => (
          <symbol
            key={shape}
            id={MARKER_ID[shape]}
            viewBox={STAGE_ICONS[shape].viewBox}
            dangerouslySetInnerHTML={{ __html: STAGE_ICONS[shape].body }}
          />
        ))}
      </defs>
    </svg>
  );
}
