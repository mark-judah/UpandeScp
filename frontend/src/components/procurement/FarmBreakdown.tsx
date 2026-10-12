/**
 * Each chemical with a column per requesting farm — what the farm asked for and,
 * once the cycle is consolidated, its share of the approved figure after the GM's
 * cut — then the total and its value. It is there to be read BEFORE approving, so
 * a farm whose requirement is not yet approved is shown but marked "pending": its
 * ask is visible, though it only counts towards the cycle once approved.
 */
import { TableRowsSkeleton } from "@/components/Loading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BreakdownCell, ItemBreakdown } from "@/lib/procurement-api";
import { fmtQty } from "@/lib/uom";
import { cn } from "@/lib/utils";

function money(n: number | null | undefined, currency: string) {
  if (n === null || n === undefined) return "—";
  return `${currency} ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.round(n))}`;
}

/** "30", or "30 → 28" when the approved share differs from the ask. */
export function cellText(c: BreakdownCell | undefined): string {
  if (!c) return "—";
  if (c.approved === null || Math.abs(c.approved - c.requested) < 1e-9) return fmtQty(c.requested);
  return `${fmtQty(c.requested)} → ${fmtQty(c.approved)}`;
}

export function FarmBreakdown({
  data,
  error,
  onRetry,
  onlyItem,
}: {
  data: ItemBreakdown | null;
  error?: string | null;
  onRetry?: () => void;
  /** Narrow to one chemical (the Consolidated tab's expanded row). */
  onlyItem?: string;
}) {
  const farms = data ? Array.from(new Set(data.farms.map((f) => f.farm))) : [];
  const status = new Map((data?.farms || []).map((f) => [f.farm, f.status]));
  const items = (data?.items || []).filter((i) => !onlyItem || i.item_code === onlyItem);
  const cur = data?.currency || "KES";
  const heads = ["Chemical", ...(farms.length ? farms : ["Farms"]), "Total", "Value"];

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-0">
        {!onlyItem && (
          <div className="px-4 pt-4">
            <p className="font-medium">Quantities by farm</p>
            <p className="text-sm text-muted-foreground">
              What each farm asked for, and its share of the approved figure once the
              cycle is consolidated. Valued at each chemical's last purchase rate (else
              its valuation rate). Totals include every farm shown; a farm marked
              pending is not approved yet and only counts towards the cycle once it is.
            </p>
          </div>
        )}
        {error ? (
          <div role="alert" className="flex items-center justify-between gap-3 px-4 pb-4 text-sm">
            <span className="text-destructive">{error}</span>
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                Try again
              </Button>
            )}
          </div>
        ) : (
          <Table aria-label="Quantities by farm">
            <TableHeader>
              <TableRow>
                {heads.map((h, i) => (
                  <TableHead key={h + i} className={cn(i > 0 && "text-right whitespace-nowrap")}>
                    {h}
                    {i > 0 && i <= farms.length && status.get(h) && status.get(h) !== "Planner Approved" && (
                      <Badge variant="secondary" className="ml-1.5 align-middle">
                        pending
                      </Badge>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody aria-busy={!data || undefined}>
              {!data && <TableRowsSkeleton cols={heads.length} rows={3} />}
              {data && items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={heads.length} className="py-6 text-center text-muted-foreground">
                    No requested quantities to compare yet.
                  </TableCell>
                </TableRow>
              )}
              {items.map((it) => (
                <TableRow key={it.item_code}>
                  <TableCell>
                    <div className="font-medium">{it.item_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {it.item_code}
                      {it.uom ? ` · ${it.uom}` : ""}
                    </div>
                  </TableCell>
                  {farms.map((f) => {
                    const c = it.by_farm[f];
                    return (
                      <TableCell
                        key={f}
                        className={cn(
                          "text-right tabular-nums",
                          c && !c.counted && "text-muted-foreground",
                        )}
                      >
                        {cellText(c)}
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right font-medium tabular-nums">
                    {it.total_approved !== null && Math.abs(it.total_approved - it.total_requested) > 1e-9
                      ? `${fmtQty(it.total_requested)} → ${fmtQty(it.total_approved)}`
                      : fmtQty(it.total_requested)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {it.approved_value !== null && it.approved_value !== it.requested_value ? (
                      <>
                        <span className="text-muted-foreground">{money(it.requested_value, cur)}</span>
                        {" → "}
                        {money(it.approved_value, cur)}
                      </>
                    ) : (
                      money(it.requested_value, cur)
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
