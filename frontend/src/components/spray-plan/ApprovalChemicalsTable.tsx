/**
 * Inline expand-panel for the Approval page showing each chemical with
 * its IRAC/FRAC codes, rate, rate-limit indicator, and resistance
 * warnings (IRAC/FRAC rotation within the configured window).
 *
 * Above the table sits the spray check for the plan; a GM can override a
 * plan awaiting override from here.
 *
 * Data comes from get_approval_review — loaded once per WO when the
 * component mounts, and again after an override.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  getApprovalReview,
  type ApprovalReview,
} from "@/lib/spray-plan-creator-api";
import { overrideSprayPlan, type OverrideInput } from "@/lib/spray-compliance-api";
import { SprayCheckCard } from "@/components/spray-plan/SprayCheckCard";
import { OverrideDialog } from "@/components/spray-plan/OverrideDialog";
import { Bar } from "@/components/Loading";

import { errorText } from "@/lib/errors";
interface Props {
  woName: string;
}

export function ApprovalChemicalsTable({ woName }: Props) {
  const [review, setReview] = useState<ApprovalReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getApprovalReview(woName)
      .then((r) => !cancelled && setReview(r))
      .catch((e) => !cancelled && setError(errorText(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [woName, reloadTick]);

  const submitOverride = useCallback(
    async (overrides: OverrideInput[]) => {
      setOverrideBusy(true);
      setOverrideError(null);
      try {
        await overrideSprayPlan(woName, overrides);
        setOverrideOpen(false);
        setReloadTick((t) => t + 1);
      } catch (e) {
        setOverrideError(errorText(e));
        setOverrideOpen(false);
      } finally {
        setOverrideBusy(false);
      }
    },
    [woName],
  );

  // First load only: after an override the old review stays until the new one lands.
  if (loading && !review) {
    return (
      <div className="px-3 py-2 border-t bg-muted/20" aria-busy="true">
        <div className="mb-2">
          <SprayCheckCard result={null} loading names={{}} />
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[0.65rem] uppercase tracking-wide text-muted-foreground">
              <th className="py-1">Chemical</th>
              <th>Codes</th>
              <th className="text-right">Rate</th>
              <th>Status</th>
              <th>Resistance</th>
            </tr>
          </thead>
          <tbody aria-hidden>
            {["62%", "48%", "56%"].map((w, i) => (
              <tr key={i} className="border-t border-border/40" data-skeleton="row">
                <td className="py-1.5">
                  {/* widths vary down the column, like names that have not arrived */}
                  <span
                    className="mb-1 block h-3 animate-pulse rounded bg-[var(--sd-bg-soft)]"
                    style={{ width: w }}
                  />
                  <Bar className="h-2.5 w-16" />
                </td>
                <td><Bar className="h-4 w-14 rounded-full" /></td>
                <td><Bar className="ml-auto h-3 w-12" /></td>
                <td><Bar className="h-3 w-8" /></td>
                <td><Bar className="h-3 w-20" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (error) {
    return (
      <div className="text-xs text-destructive flex items-start gap-1 px-2 py-3">
        <AlertTriangle className="h-3 w-3 mt-[1px]" />
        <span>{error}</span>
      </div>
    );
  }
  if (!review) return null;

  const compliance = review.compliance ?? null;
  const canOverride = compliance?.status === "Awaiting Override" && compliance.can_override;

  return (
    <div className="px-3 py-2 border-t bg-muted/20">
      <div className="mb-2">
        <SprayCheckCard
          result={compliance}
          loading={false}
          names={Object.fromEntries(review.chemicals.map((c) => [c.item_code, c.item_name || c.item_code]))}
          overrides={compliance?.overrides}
          onOverride={canOverride ? () => setOverrideOpen(true) : undefined}
        />
        {overrideError && (
          <div className="mt-1 text-[0.65rem] text-destructive flex items-start gap-1">
            <AlertTriangle className="h-3 w-3 mt-[1px] shrink-0" />
            <span>{overrideError}</span>
          </div>
        )}
      </div>
      {compliance && (
        <OverrideDialog
          open={overrideOpen}
          onOpenChange={setOverrideOpen}
          violations={compliance.violations}
          onConfirm={submitOverride}
          confirmLabel="Override"
          busy={overrideBusy}
        />
      )}
      {review.plan_warnings.length > 0 && (
        <div className="mb-2 text-[0.65rem] text-amber-700 dark:text-amber-400 flex flex-wrap gap-2">
          {review.plan_warnings.map((w) => (
            <span key={w} className="inline-flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {w}
            </span>
          ))}
        </div>
      )}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[0.65rem] uppercase tracking-wide text-muted-foreground">
            <th className="py-1">Chemical</th>
            <th>Codes</th>
            <th className="text-right">Rate</th>
            <th>Status</th>
            <th>Resistance</th>
          </tr>
        </thead>
        <tbody>
          {review.chemicals.map((c) => (
            <tr key={c.item_code} className="border-t border-border/40">
              <td className="py-1.5 align-top">
                <div className="font-medium">{c.item_name || c.item_code}</div>
                <div className="text-[0.6rem] text-muted-foreground font-mono">{c.item_code}</div>
              </td>
              <td className="align-top">
                <div className="flex flex-wrap gap-1">
                  {c.irac_code && (
                    <Badge variant="outline" className="text-[0.6rem]">
                      IRAC {c.irac_code}
                    </Badge>
                  )}
                  {c.frac_code && (
                    <Badge variant="outline" className="text-[0.6rem]">
                      FRAC {c.frac_code}
                    </Badge>
                  )}
                  {!c.irac_code && !c.frac_code && (
                    <span className="text-[0.6rem] text-muted-foreground">—</span>
                  )}
                </div>
              </td>
              <td className="text-right tabular-nums align-top">
                {c.application_rate?.toFixed(2)} {c.stock_uom}
              </td>
              <td className="align-top">
                {c.rate_status === "ok" && (
                  <span className="text-[0.65rem] text-[var(--sd-data-green)]">OK</span>
                )}
                {c.rate_status === "below" && (
                  <span className="text-[0.65rem] text-amber-600">below limit</span>
                )}
                {c.rate_status === "above" && (
                  <span className="text-[0.65rem] text-destructive">above limit</span>
                )}
              </td>
              <td className="align-top">
                {c.resistance_warnings.length === 0 ? (
                  <span className="text-[0.65rem] text-muted-foreground">—</span>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {c.resistance_warnings.map((w, i) => (
                      <span
                        key={`${w.kind}-${w.code}-${i}`}
                        className="text-[0.6rem] text-amber-700 dark:text-amber-400"
                      >
                        {w.message}
                      </span>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
