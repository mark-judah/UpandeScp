/**
 * Stage key for the heatmaps: maps each marker shape to the stage it
 * represents. Shapes are stage-driven and consistent across pests (Adult ->
 * circle everywhere, Nymph -> pentagon, ...), so this key lets a user decode
 * the markers on the bed map. Built from the markers actually in view, so it
 * only lists the stages currently shown.
 *
 * Requires <MarkerDefs/> to be mounted on the page (it supplies the symbols
 * referenced via <use>).
 */

import { LEVEL_LABELS, softFill, paperFor } from "@/lib/heat-style";
import { MARKER_ID, type MarkerShape } from "@/pages/maps/MarkerDefs";

export interface StageLegendItem {
  stage?: string;
  shape?: MarkerShape;
}

export function StageLegend({
  markers,
  className,
}: {
  markers: StageLegendItem[];
  className?: string;
}) {
  // One entry per distinct stage that has a label; keep the first shape seen.
  const byStage = new Map<string, MarkerShape>();
  for (const m of markers) {
    const stage = (m.stage || "").trim();
    if (!stage || byStage.has(stage)) continue;
    byStage.set(stage, m.shape || "circle");
  }
  const items = [...byStage.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (!items.length) return null;

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "6px 14px",
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-muted, #6b7280)",
        }}
      >
        Stages
      </span>
      {items.map(([stage, shape]) => (
        <span
          key={stage}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11 }}
        >
          <svg width={13} height={13} viewBox="-6 -6 12 12" aria-hidden style={{ overflow: "visible" }}>
            <use
              href={`#${MARKER_ID[shape]}`}
              x={-5}
              y={-5}
              width={10}
              height={10}
              stroke="var(--heat-glyph, #3a3a34)"
              strokeWidth={0.6}
              fill="none"
            />
          </svg>
          <span style={{ color: "var(--text, #374151)" }}>{stage}</span>
        </span>
      ))}
    </div>
  );
}

/** The level ramp as soft swatches (Low .. Severe), in a given target colour. */
export function HeatRampLegend({
  color = "#6b7280",
  className,
}: {
  color?: string;
  className?: string;
}) {
  const paper = paperFor();
  return (
    <div
      className={className}
      data-testid="heat-ramp-legend"
      style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11 }}
    >
      <span style={{ fontWeight: 600, color: "var(--text-muted, #6b7280)" }}>Level</span>
      {LEVEL_LABELS.map((label, i) => (
        <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span
            aria-hidden
            style={{
              width: 18,
              height: 10,
              borderRadius: 6,
              background: softFill(color, i + 1, paper),
            }}
          />
          <span style={{ color: "var(--text, #374151)" }}>{label}</span>
        </span>
      ))}
    </div>
  );
}
