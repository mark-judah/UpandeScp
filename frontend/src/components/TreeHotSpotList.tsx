/**
 * A block's hot spots by tree (neighbouring trees over the pest's per-tree
 * band), the second level shown beside its per-hectare figure. Each row opens
 * the avocado Observations map on the block with the pest picked.
 */
import { Button } from "@/components/ui/button";
import { openHotSpotOnMap } from "@/lib/hot-spot-focus";
import { ACTION_TONE, type AlertAction } from "@/lib/scouting-alerts-api";

export interface TreeHotSpotRow {
  name: string;
  observation: string;
  kind: "pest" | "disease";
  week: string;
  band: "Moderate" | "High";
  action: AlertAction;
  /** the worst tree's count */
  peak: number | null;
  trees: number;
  /** "7 trees · rows 12–14, trees 3–9 · High, peak 9 per tree" */
  label: string;
  status: string;
}

export function TreeHotSpotList({
  crop, block, spots, showObservation = true,
}: { crop: string; block: string; spots: TreeHotSpotRow[]; showObservation?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="tree-hot-spots">
      <div className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
        Hot spots by tree
      </div>
      {spots.length ? (
        spots.map((s) => {
          const tone = ACTION_TONE[s.action] ?? "var(--sd-muted)";
          const where = (s.label || "").split(" · ")[1] ?? "";
          return (
            <div key={s.name} data-testid="tree-hot-spot" className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className="inline-flex items-center rounded-full px-1.5 py-px text-[0.6rem] font-medium leading-none"
                style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
              >
                {s.band}
              </span>
              <span className="tabular-nums">
                {showObservation ? `${s.observation}: ` : ""}
                {s.trees} trees{where ? `, ${where.split(", ")[0]}` : ""}
                {s.peak != null ? ` · worst tree ${s.peak}` : ""}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto h-6 px-2 text-[0.65rem]"
                onClick={() => openHotSpotOnMap(crop, { block, kind: s.kind, observation: s.observation })}
              >
                Show on map
              </Button>
            </div>
          );
        })
      ) : (
        <div className="text-xs text-muted-foreground" data-testid="no-tree-hot-spots">
          No hot spot by tree this week.
        </div>
      )}
    </div>
  );
}
