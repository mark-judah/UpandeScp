/**
 * Shared marker symbol library for the heatmap POC and (eventually) the
 * production Heatmaps page.
 *
 * Each observation kind maps to a single SVG ``<symbol>`` whose viewBox is
 * a centered 10×10 box, so a ``<use href="#m-pest" x="cx" y="cy" />`` lands
 * with the marker centered at (cx, cy). The fill comes from the Pest /
 * Plant Disease doctype's legend hex.
 *
 * Render this component exactly once per page (at the top of the
 * Heatmap-rendering subtree). Every BedSvg below references the IDs via
 * ``<use>``.
 */

export const MARKER_ID = {
  pest:    "scp-m-pest",
  disease: "scp-m-disease",
  trap:    "scp-m-trap",
  fcm:     "scp-m-fcm",
} as const;

export type MarkerKind = keyof typeof MARKER_ID;

export function MarkerDefs() {
  return (
    <svg
      width={0}
      height={0}
      aria-hidden="true"
      style={{ position: "absolute" }}
    >
      <defs>
        {/* Centered 10×10 viewBox so every shape lines up at <use x y>. */}
        <symbol id={MARKER_ID.pest} viewBox="-5 -5 10 10">
          <circle r="4" stroke="black" strokeWidth="0.5" />
        </symbol>
        <symbol id={MARKER_ID.disease} viewBox="-5 -5 10 10">
          <polygon points="0,-4 4,3 -4,3" stroke="black" strokeWidth="0.5" />
        </symbol>
        <symbol id={MARKER_ID.trap} viewBox="-5 -5 10 10">
          <rect x="-3.5" y="-3.5" width="7" height="7" stroke="black" strokeWidth="0.5" />
        </symbol>
        <symbol id={MARKER_ID.fcm} viewBox="-5 -5 10 10">
          <path
            d="M0,-4 L1,-1 4,-1 1.5,1 2.5,4 0,2 -2.5,4 -1.5,1 -4,-1 -1,-1 Z"
            stroke="black"
            strokeWidth="0.5"
          />
        </symbol>
      </defs>
    </svg>
  );
}
