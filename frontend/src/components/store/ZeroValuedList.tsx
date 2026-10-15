/**
 * Batches that hold stock but came in with no valuation rate.
 *
 * Such a batch cannot be issued: the tank mix made from it cannot be costed, so the
 * spray would stop at the Manufacture. The transfers page refuses it and the batch
 * pickers grey it out; this lists them so the store can correct the valuation (a Stock
 * Reconciliation or the purchase receipt rate). Read-only: nothing is fixed here.
 */
import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { fetchZeroValuedBatches, type ZeroValuedBatch } from "@/lib/store-keeper-api";

function fmt(n: number): string {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export function ZeroValuedList() {
  const [rows, setRows] = useState<ZeroValuedBatch[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    fetchZeroValuedBatches()
      .then((r) => live && setRows(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!rows.length) return null;
  return (
    <div className="px-4 md:px-6" data-testid="zero-valued-list">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs font-medium text-destructive"
        aria-expanded={open}
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        Zero-valued batches ({rows.length}) — can't be issued until their valuation is corrected
      </button>
      {open && (
        <table className="mt-2 w-full text-xs">
          <thead className="text-[0.65rem] uppercase tracking-wide text-muted-foreground border-b">
            <tr>
              <th className="text-left px-2 py-1">Chemical</th>
              <th className="text-left px-2 py-1">Batch</th>
              <th className="text-left px-2 py-1">Store</th>
              <th className="text-left px-2 py-1">Valued by</th>
              <th className="text-right px-2 py-1">Rate</th>
              <th className="text-right px-2 py-1">Qty</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.item_code}|${r.batch_no}|${r.warehouse}`} className="border-b last:border-0">
                <td className="px-2 py-1">
                  <span className="font-medium">{r.item_name}</span>{" "}
                  <span className="font-mono text-[0.6rem] text-muted-foreground">{r.item_code}</span>
                </td>
                <td className="px-2 py-1 font-mono">{r.batch_no}</td>
                <td className="px-2 py-1 text-muted-foreground">{r.warehouse}</td>
                <td className="px-2 py-1 text-muted-foreground">
                  {r.method === "batchwise" ? "Batch value" : "Item moving average"}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{fmt(r.rate)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmt(r.qty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
