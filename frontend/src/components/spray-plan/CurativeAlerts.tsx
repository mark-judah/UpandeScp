/**
 * Open spray actions on the picked greenhouse, each with "Create curative plan"
 * (thresholds spec D7). Replaces the old client-side zone-coverage
 * "recommendation": the band and the action come from the server.
 */
import { Button } from "@/components/ui/button";
import { AlertActionPill } from "@/components/AlertActionPill";
import { alertFigureLine, type CreatorAlert } from "@/lib/scouting-alerts-api";

export function CurativeAlerts({
  alerts,
  activeAlert,
  onCreate,
}: {
  alerts: CreatorAlert[];
  activeAlert?: string;
  onCreate: (a: CreatorAlert) => void;
}) {
  if (!alerts.length) {
    return (
      <div className="text-xs text-muted-foreground" data-testid="no-curative-alerts">
        No spray threshold crossed in the latest scouted week.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5" data-testid="curative-alerts">
      {alerts.map((a) => (
        <div key={a.name} className="flex flex-wrap items-center gap-2 text-xs">
          <AlertActionPill action={a.action} />
          <span className="font-medium">
            {a.observation}
            {a.stage ? ` · ${a.stage}` : ""}
          </span>
          <span className="tabular-nums text-muted-foreground">{alertFigureLine(a)}</span>
          <span className="text-muted-foreground">{a.iso_week}</span>
          <Button
            type="button"
            size="sm"
            variant={activeAlert === a.name ? "default" : "outline"}
            className="ml-auto h-6 px-2 text-[0.65rem]"
            onClick={() => onCreate(a)}
          >
            {activeAlert === a.name ? "In this plan" : "Create curative plan"}
          </Button>
        </div>
      ))}
    </div>
  );
}

/**
 * The alert link a plan keeps: dropped (returns "") once the plan no longer
 * targets the alert's pest, so the alert is never marked Converted by a plan
 * that does not treat it.
 */
export function alertLinkFor(
  alerts: CreatorAlert[] | undefined,
  linked: string,
  targets: ReadonlySet<string>,
): string {
  if (!linked) return "";
  const a = (alerts || []).find((x) => x.name === linked);
  return a && targets.has(a.observation) ? linked : "";
}
