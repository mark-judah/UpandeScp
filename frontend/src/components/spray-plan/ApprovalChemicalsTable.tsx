/**
 * Inline expand-panel for the Approval page showing each chemical with
 * its IRAC/FRAC codes, rate, rate-limit indicator, and resistance
 * warnings (IRAC/FRAC rotation within the configured window).
 *
 * Data comes from get_approval_review — loaded once per WO when the
 * component mounts.
 */

import { useEffect, useState } from "react";
import { Loader2, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  getApprovalReview,
  type ApprovalReview,
} from "@/lib/spray-plan-creator-api";

interface Props {
  woName: string;
}

export function ApprovalChemicalsTable({ woName }: Props) {
  const [review, setReview] = useState<ApprovalReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getApprovalReview(woName)
      .then((r) => !cancelled && setReview(r))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [woName]);

  if (loading) {
    return (
      <div className="text-xs text-muted-foreground flex items-center gap-2 px-2 py-3">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading chemical review…
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

  return (
    <div className="px-3 py-2 border-t bg-muted/20">
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
