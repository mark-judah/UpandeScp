/**
 * The plan's chemicals: Chemical, Rate, Quantity, Available (net of other draft plans)
 * and — only when some row's item must name one — Batch. Moved from the roses
 * Application Plan's chemical table; the field planner shows the same table per block,
 * where a rate is measured per its own unit of water or area (lib/spray-rates).
 */
import type { ReactNode } from "react";
import { ShieldAlert, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtQty, fromStockQty } from "@/lib/uom";
import { itemNeedsBatch } from "@/lib/stock-availability";
import { chemicalQty, rateOutOfRange, typedWater } from "@/lib/open-field";
import { BASIS_NAME, dilutionLine, perLabel } from "@/lib/spray-rates";
import { rateLimitError } from "./plan-form-utils";
import type { PlanChemical, PlanFormState } from "./useSprayPlanForm";

/** A block row's quantity cell: the amount, or what is still needed to work it out. */
export function rowQty(c: PlanChemical, area: number, water: number): string {
  if (c.basis === "Water" && c.rate > 0 && !(water > 0)) return "enter the water";
  if (c.basis === "Hectarage" && c.rate > 0 && !(area > 0)) return "enter the block area";
  return `${chemicalQty(c, area, water).toFixed(2)} ${c.stock_uom || ""}`;
}

export function ChemicalTable({
  state,
  flagged,
  renderInfo,
}: {
  state: PlanFormState;
  /** items named by an un-overridden spray-check violation */
  flagged?: Set<string>;
  /** extra lines under a chemical's name (targets, codes, active ingredients) */
  renderInfo?: (c: PlanChemical) => ReactNode;
}) {
  const block = state.placeKind === "block";
  const rows = state.chemicals;
  const water = typedWater(state.value);
  const showBatch = rows.some((c) => state.needsBatch(c));
  const showUom = !block;

  return (
    <Table data-testid="chemical-table">
      <TableHeader>
        <TableRow>
          <TableHead>Chemical</TableHead>
          <TableHead className="text-right">{block ? "Rate" : "Rate / 1000 L"}</TableHead>
          {showUom && <TableHead>UoM</TableHead>}
          <TableHead className="text-right">Quantity</TableHead>
          <TableHead className="text-right">Available</TableHead>
          {showBatch && <TableHead>Batch</TableHead>}
          <TableHead className="w-8" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((c, i) => {
          const id = state.rowKey(c, i);
          const need = state.qtyOf(c);
          const limitErr = block ? null : rateLimitError(c.item_code, c.rate, state.rateLimits);
          const lim = state.rateLimits[c.item_code || ""];
          const hintParts: string[] = [];
          if (!block && lim?.lower != null) hintParts.push(`min ${lim.lower}`);
          if (!block && lim?.upper != null) hintParts.push(`max ${lim.upper}`);
          const hint = hintParts.length ? hintParts.join(" · ") : "";
          const rem = state.remainingFor(c);
          const name = c.item_name || c.item_code;
          return (
            <TableRow key={id}>
              <TableCell className="text-xs">
                <div className="font-medium flex flex-wrap items-center gap-1.5">
                  {flagged?.has(c.item_code) && (
                    <ShieldAlert
                      className="h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-400"
                      aria-label="Named by the spray check"
                    />
                  )}
                  {name}
                  <Badge
                    variant="outline"
                    className={
                      c.is_fertilizer
                        ? "h-4 px-1.5 text-[0.6rem] uppercase border-[var(--sd-data-green)] text-[var(--sd-data-green)]"
                        : "h-4 px-1.5 text-[0.6rem] uppercase border-[var(--sd-data-cyan)] text-[var(--sd-data-cyan)]"
                    }
                  >
                    {c.is_fertilizer ? "Fertilizer" : "Chemical"}
                  </Badge>
                </div>
                {renderInfo?.(c)}
                <div className="text-[0.65rem] text-muted-foreground font-mono">{c.item_code}</div>
              </TableCell>
              <TableCell className="text-right">
                {block && (
                  <div className="mb-0.5 text-[0.65rem] text-muted-foreground" data-testid="rate-basis">
                    {BASIS_NAME[c.basis]} · {c.stock_uom || "units"} {perLabel(c.basis, c)}
                  </div>
                )}
                <Input
                  value={c.rate?.toString() || (block ? "0" : "")}
                  onChange={(e) => state.setRate(id, Number(e.target.value))}
                  type="number"
                  step="any"
                  min={0}
                  aria-label={`Rate of ${name}`}
                  aria-invalid={!!limitErr}
                  className={
                    limitErr
                      ? "h-7 text-xs text-right tabular-nums w-24 ml-auto border-[var(--sd-data-red)] focus-visible:ring-[var(--sd-data-red)]"
                      : "h-7 text-xs text-right tabular-nums w-24 ml-auto"
                  }
                />
                {limitErr ? (
                  <div className="text-[0.65rem] text-[var(--sd-data-red)] mt-0.5 max-w-[10rem] ml-auto text-right">
                    {limitErr}
                  </div>
                ) : hint ? (
                  <div className="text-[0.6rem] text-muted-foreground mt-0.5 text-right tabular-nums">{hint}</div>
                ) : null}
              </TableCell>
              {showUom && (
                <TableCell className="text-xs">
                  {/* UoM options come from ERPNext's own UOM Conversion Detail rows on
                      the Item, so an operator can order in bottles or grams and the
                      factor is whatever the Item says — this app holds no conversion
                      table. Falls back to plain text when only the stock UOM applies. */}
                  {(c.uoms?.length ?? 0) > 1 ? (
                    <Select value={c.stock_uom || ""} onValueChange={(v) => state.setUom(id, v)}>
                      <SelectTrigger className="h-7 w-24 text-xs" aria-label={`Unit of ${name}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {c.uoms!.map((u) => (
                          <SelectItem key={u.uom} value={u.uom}>
                            {u.uom}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-muted-foreground">{c.stock_uom || ""}</span>
                  )}
                </TableCell>
              )}
              <TableCell className="text-right text-xs tabular-nums" data-testid={`qty-${c.item_code}`}>
                {block ? (
                  <>
                    {rowQty(c, state.areaHa, water)}
                    {c.basis === "Hectarage" && water > 0 && c.rate > 0 && (
                      <div className="text-[0.65rem] font-normal text-muted-foreground" data-testid="dilution">
                        {dilutionLine(chemicalQty(c, state.areaHa, water), water, c.stock_uom)}
                      </div>
                    )}
                    {rateOutOfRange(c) && (
                      <div className="text-[0.65rem] text-amber-600">
                        outside {c.lower ?? 0}-{c.upper ?? "open"}
                      </div>
                    )}
                  </>
                ) : need > 0 ? (
                  <>
                    {need.toFixed(2)}
                    <span className="ml-1 text-[0.65rem] text-muted-foreground">{c.stock_uom || ""}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              {/* Available at the picked source, in the row's CHOSEN unit — a
                  bottle-stocked item shown beside a gram rate would otherwise read as
                  50 when it is 25,000. Draft-aware: it nets off other queued plans,
                  which is what the Submit gate uses. */}
              <TableCell className="text-right text-xs tabular-nums">
                {c.source ? (
                  <span
                    data-testid={`available-${c.item_code}`}
                    className={
                      need && state.rowAvailable(c) < need
                        ? "font-medium text-[var(--sd-data-red)]"
                        : "text-muted-foreground"
                    }
                    title={`${fmtQty(state.rowAvailable(c))} ${c.uoms?.[0]?.uom ?? ""} on hand at ${c.source}, net of other draft plans`}
                  >
                    {fmtQty(fromStockQty(state.rowAvailable(c), c.uoms, c.stock_uom))}
                    <span className="ml-1 text-[0.65rem] text-muted-foreground">{c.stock_uom || ""}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
                {rem && (
                  <div className="mt-1 space-y-0.5 text-[0.6rem] text-muted-foreground text-right">
                    <div title="On hand, less submitted plans in the reservation window, less this plan">
                      After this plan: <Fig n={rem.after} />
                    </div>
                    <div title="Also counting every draft and pending plan">
                      If all pending approved: <Fig n={rem.ifAll} />
                    </div>
                    {rem.a.no_batches ? (
                      <div className="pt-0.5 text-amber-700 dark:text-amber-300" data-testid="no-batches-note">
                        No batches in {c.source}
                      </div>
                    ) : null}
                  </div>
                )}
              </TableCell>
              {showBatch && (
                <TableCell className="text-xs">
                  {rem && itemNeedsBatch(rem.a) ? (
                    <Select value={c.batch_no || ""} onValueChange={(v) => state.setBatch(id, v)}>
                      <SelectTrigger
                        aria-label={`Batch for ${name}`}
                        className={`h-7 w-44 text-xs ${c.batch_no ? "" : "border-amber-500"}`}
                      >
                        <SelectValue placeholder="Pick a batch" />
                      </SelectTrigger>
                      <SelectContent>
                        {rem.a.batches.map((b) => (
                          <SelectItem key={b.batch_no} value={b.batch_no} disabled={!!b.zero_valued}>
                            <span className={state.batchTone(b, need)}>
                              {b.batch_no} · {fmtQty(b.available)} free
                              {b.zero_valued
                                ? " · No valuation rate — can't be issued"
                                : b.expired
                                  ? " · expired"
                                  : b.placeholder
                                    ? " · opening stock"
                                    : b.expiry_date
                                      ? ` · exp ${b.expiry_date}`
                                      : ""}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              )}
              <TableCell>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground"
                  onClick={() => state.removeChemical(id)}
                  title="Remove"
                  aria-label={`Remove ${name}`}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function Fig({ n }: { n: number }) {
  return <span className={n < 0 ? "font-medium text-[var(--sd-data-red)]" : ""}>{fmtQty(n)}</span>;
}
