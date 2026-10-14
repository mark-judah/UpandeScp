/**
 * The spray check for one plan: which targets the mix covers, and every rule
 * the mix breaks, grouped by rule. The server decides; this only presents it.
 * Used by the creator (live, as the mix changes) and the approval page.
 */
import { CheckCircle2, AlertTriangle, ShieldAlert, Loader2 } from "lucide-react";
import { TextSkeleton } from "@/components/Loading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  groupViolations,
  modeBadge,
  type CheckResult,
  type RecordedOverride,
} from "@/lib/spray-compliance-api";

const TONE: Record<string, string> = {
  red: "text-destructive",
  amber: "text-amber-700 dark:text-amber-400",
  muted: "text-muted-foreground",
  green: "text-[var(--sd-data-green)]",
};

export function SprayCheckCard({
  result,
  loading,
  names,
  overrides,
  onOverride,
}: {
  result: CheckResult | null;
  loading: boolean;
  /** item_code → display name for the products the check mentions. */
  names: Record<string, string>;
  /** Overrides recorded on a saved plan (approval page). */
  overrides?: RecordedOverride[];
  /** When given, an "Override" button is shown in the header. */
  onOverride?: () => void;
}) {
  const nm = (i: string) => names[i] ?? i;
  return (
    <Card className="p-4">
      <CardHeader className="p-0 pb-2 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm">Spray check</CardTitle>
        <div className="flex items-center gap-2">
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {onOverride && (
            <Button size="sm" variant="outline" className="h-7 text-[0.7rem]" onClick={onOverride}>
              Override
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0 flex flex-col gap-3 text-xs" aria-busy={(loading && !result) || undefined}>
        {!result && loading ? (
          // First check in flight: not "pick targets" — the plan has them.
          <span className="flex flex-col gap-1.5 py-0.5">
            <TextSkeleton width="70%" />
            <TextSkeleton width="45%" />
          </span>
        ) : !result ? (
          <span className="text-muted-foreground">Pick targets and a tank mix to check this plan.</span>
        ) : result.status === "Check failed" ? (
          <span className="inline-flex items-start gap-1.5 text-muted-foreground">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {result.message || "The spray check could not run for this plan."}
          </span>
        ) : (
          <>
            {result.coverage.length > 0 && (
              <table className="w-full">
                <tbody>
                  {result.coverage.map((c) => (
                    <tr key={c.target} className="border-b last:border-0">
                      <td className="py-1 pr-2 font-medium align-top">{c.target}</td>
                      <td className="py-1">
                        {c.products.length ? (
                          <span className="inline-flex items-center gap-1">
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--sd-data-green)]" />
                            {c.products.map(nm).join(", ")}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-destructive">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Not covered
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {result.violations.length === 0 ? (
              <span className="inline-flex items-center gap-1.5 text-[var(--sd-data-green)]">
                <CheckCircle2 className="h-4 w-4" /> All checks pass
              </span>
            ) : (
              groupViolations(result.violations).map((g) => (
                <div key={g.rule} className="flex flex-col gap-1">
                  <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">{g.label}</div>
                  {g.items.map((v) => {
                    const b = modeBadge(v.mode, v.overridden);
                    return (
                      <div key={v.key} className="flex items-start gap-2">
                        <ShieldAlert className={`h-3.5 w-3.5 mt-[1px] shrink-0 ${TONE[b.tone]}`} />
                        <span className="flex-1">{v.message}</span>
                        <Badge variant="outline" className={`shrink-0 ${TONE[b.tone]}`}>
                          {b.text}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
            {overrides && overrides.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">Overrides</div>
                {overrides.map((o, i) =>
                  o.honoured ? (
                    <div key={i}>
                      {o.reason}{" "}
                      <span className="text-muted-foreground">
                        — {o.overridden_by}, {o.overridden_on.slice(0, 16)}
                      </span>
                    </div>
                  ) : (
                    <div
                      key={i}
                      className="text-muted-foreground"
                      title="Not counted: whoever gave it cannot override a spray check."
                    >
                      {o.reason} — {o.overridden_by}, {o.overridden_on.slice(0, 16)}
                      <Badge variant="outline" className="ml-1.5 text-muted-foreground">
                        not valid
                      </Badge>
                    </div>
                  ),
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
