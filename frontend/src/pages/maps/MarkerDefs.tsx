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
 * Each ``<symbol>`` uses a centered 10×10 viewBox so a
 * ``<use href="#scp-m-X" x="cx" y="cy" />`` lands with the marker
 * centred at (cx, cy). The caller passes ``stroke`` (line colour); fill
 * stays transparent so the bed line behind the marker shows through.
 */

export const MARKER_ID = {
  circle:   "scp-m-circle",   // default / no stage
  triangle: "scp-m-triangle",
  pentagon: "scp-m-pentagon",
  diamond:  "scp-m-diamond",  // tilted square
  cross:    "scp-m-cross",    // X
  plus:     "scp-m-plus",     // +
} as const;

export type MarkerShape = keyof typeof MARKER_ID;

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
  // Markers are now filled — the caller passes the pest's legend colour
  // as ``fill``. We keep a hairline same-colour stroke for crisp edges
  // when the marker overlaps a bed line. ``non-scaling-stroke`` so dense
  // maps don't get smudgy as the SVG zooms.
  const sw = 0.4;
  const ve = "non-scaling-stroke";

  return (
    <svg
      width={0}
      height={0}
      aria-hidden="true"
      style={{ position: "absolute" }}
    >
      <defs>
        <symbol id={MARKER_ID.circle} viewBox="-5 -5 10 10">
          <circle r="4" strokeWidth={sw} vectorEffect={ve} />
        </symbol>

        <symbol id={MARKER_ID.triangle} viewBox="-5 -5 10 10">
          <polygon
            points="0,-4 3.6,2.6 -3.6,2.6"
            strokeWidth={sw}
            strokeLinejoin="round"
            vectorEffect={ve}
          />
        </symbol>

        <symbol id={MARKER_ID.pentagon} viewBox="-5 -5 10 10">
          <polygon
            points="0,-4 3.8,-1.2 2.4,3.2 -2.4,3.2 -3.8,-1.2"
            strokeWidth={sw}
            strokeLinejoin="round"
            vectorEffect={ve}
          />
        </symbol>

        <symbol id={MARKER_ID.diamond} viewBox="-5 -5 10 10">
          <polygon
            points="0,-4 4,0 0,4 -4,0"
            strokeWidth={sw}
            strokeLinejoin="round"
            vectorEffect={ve}
          />
        </symbol>

        {/* Cross/plus stay outlined-only — a filled stroke shape is just
            the stroke. We thicken the stroke a touch so they read at the
            new smaller marker size. */}
        <symbol id={MARKER_ID.cross} viewBox="-5 -5 10 10">
          <path
            d="M-3.2 -3.2 L3.2 3.2 M3.2 -3.2 L-3.2 3.2"
            fill="none"
            strokeWidth={1.6}
            strokeLinecap="round"
            vectorEffect={ve}
          />
        </symbol>

        <symbol id={MARKER_ID.plus} viewBox="-5 -5 10 10">
          <path
            d="M0 -3.8 L0 3.8 M-3.8 0 L3.8 0"
            fill="none"
            strokeWidth={1.6}
            strokeLinecap="round"
            vectorEffect={ve}
          />
        </symbol>
      </defs>
    </svg>
  );
}
