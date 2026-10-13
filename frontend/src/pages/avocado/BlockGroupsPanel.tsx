import { Button } from "@/components/ui/button";
import { areaShares } from "@/lib/block-groups";

export const groupKey = (g: string[]) => g.join("|");

/**
 * The selected blocks as spray runs: touching blocks form one run (one plan),
 * the rest are separate runs. Each run lists its blocks with area, share of the
 * run and the cost centre that share will be booked to.
 */
export function BlockGroupsPanel({
  groups,
  areas,
  costCenters,
  activeKey,
  onPlan,
}: {
  groups: string[][];
  areas: Record<string, number | undefined>;
  costCenters: Record<string, string | null | undefined>;
  activeKey: string | null;
  onPlan: (group: string[]) => void;
}) {
  if (!groups.length) return null;
  return (
    <div className="space-y-2" data-testid="block-groups">
      {groups.length > 1 && (
        <div className="text-[0.7rem] font-medium text-muted-foreground">
          {groups.length} separate runs — these blocks do not touch
        </div>
      )}
      {groups.map((g, gi) => {
        const total = g.reduce((s, b) => s + (areas[b] || 0), 0);
        const shares = areaShares(areas, g);
        const noArea = g.filter((b) => !(areas[b] && areas[b]! > 0));
        const key = groupKey(g);
        return (
          <div key={key} className="rounded-lg border border-border px-2.5 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">
                {groups.length > 1 ? `Run ${gi + 1} · ` : ""}
                {g.length} {g.length === 1 ? "block" : "blocks"}
                {g.length > 1 ? " joined" : ""}
              </span>
              <span className="tabular-nums">{total.toFixed(2)} ha</span>
            </div>
            <div className="mt-1.5 space-y-0.5">
              {g.map((b) => (
                <div key={b} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate" title={b}>
                    {b}
                  </span>
                  {areas[b] && areas[b]! > 0 ? (
                    <>
                      <span className="tabular-nums text-muted-foreground">{areas[b]!.toFixed(2)} ha</span>
                      <span className="w-9 text-right tabular-nums">{Math.round(shares[b] * 100)}%</span>
                    </>
                  ) : (
                    <span className="text-destructive">no area — can't be planned</span>
                  )}
                </div>
              ))}
            </div>
            {g.length > 1 && (
              <div className="mt-1.5 border-t border-border pt-1.5">
                <div className="mb-0.5 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                  Cost centre split
                </div>
                {g.map((b) => (
                  <div key={b} className="flex items-center gap-2 text-[0.7rem]">
                    <span className="w-9 tabular-nums">{Math.round(shares[b] * 100)}%</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground" title={costCenters[b] || undefined}>
                      {costCenters[b] || "derived on save"}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <Button
              size="sm"
              variant={activeKey === key ? "default" : "outline"}
              className="mt-2 w-full"
              disabled={noArea.length > 0}
              onClick={() => onPlan(g)}
            >
              {groups.length > 1 ? `Plan run ${gi + 1}` : g.length > 1 ? "Plan this group" : "Plan spray"}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
