/**
 * Chemical setup worklist — chemicals sprayed in the last N days whose master data is
 * incomplete (active ingredient, concentration, toxicity, HML, PHI, FRAC/IRAC group).
 * Finishing these is what fills the logsheet's chemistry columns.
 */

import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TextSkeleton } from "@/components/Loading";
import { fetchChemicalSetup, type ChemicalSetupResponse } from "@/lib/settings-api";
import { errorText } from "@/lib/errors";

interface Props {
  days?: number;
  onEdit: (itemCode: string) => void;
  /** Bumped by the parent after a drawer save so the list refreshes. */
  refreshKey?: number;
}

export function ChemicalSetupCard({ days = 90, onEdit, refreshKey = 0 }: Props) {
  const [data, setData] = useState<ChemicalSetupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetchChemicalSetup(days).then(setData).catch((e) => setError(errorText(e)));
  }, [days, refreshKey]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Chemical setup</CardTitle>
        <CardDescription>
          Chemicals sprayed in the last {days} days with missing master data. Fill these once
          and every logsheet shows the active ingredient, toxicity class and total a.i.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0 flex flex-col gap-3">
        {error && <div className="text-xs text-destructive">{error}</div>}
        {!data && !error && <TextSkeleton width="30ch" />}
        {data && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-semibold tabular-nums">
                {data.with_gaps} of {data.chemicals_used} used chemicals have gaps
              </span>
              {Object.entries(data.labels).map(([k, label]) => (
                <span
                  key={k}
                  className="rounded-full border px-2 py-0.5 tabular-nums text-muted-foreground"
                >
                  {label} {data.counts[k] ?? 0}
                </span>
              ))}
              {data.rows.length > 0 && (
                <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs" onClick={() => setOpen(!open)}>
                  {open ? "Hide list" : "Show list"}
                </Button>
              )}
            </div>
            {open && (
              <ul className="divide-y rounded-md border">
                {data.rows.map((r) => (
                  <li key={r.item_code} className="flex items-center gap-3 px-3 py-2 text-xs">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold truncate">{r.item_name}</div>
                      <div className="text-[0.65rem] text-muted-foreground">
                        sprayed {r.times_sprayed}x · missing:{" "}
                        {r.gaps.map((g) => data.labels[g] || g).join(", ")}
                      </div>
                    </div>
                    <Button variant="outline" size="sm" className="h-7 gap-1" onClick={() => onEdit(r.item_code)}>
                      <Pencil className="h-3 w-3" />
                      Edit
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
