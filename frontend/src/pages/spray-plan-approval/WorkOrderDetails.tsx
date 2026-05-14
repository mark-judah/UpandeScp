import { fmtCreation, fmtQty, parseTargets } from "./utils"
import type { WorkOrder } from "./types"

interface Props {
  wo: WorkOrder
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-sm font-medium text-foreground">{value || "—"}</span>
    </div>
  )
}

export function WorkOrderDetails({ wo }: Props) {
  const scopeVal = [wo.custom_scope, wo.custom_scope_details].filter(Boolean).join(" — ")
  const items = wo.required_items ?? []
  const targets = parseTargets(wo.custom_targets)

  return (
    <div className="space-y-4 rounded-md border bg-muted/30 p-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        <Field label="Scope" value={scopeVal || "—"} />
        <Field label="Area" value={wo.custom_area ? `${wo.custom_area} Ha` : "—"} />
        <Field
          label="Water Volume"
          value={wo.custom_water_volume ? `${wo.custom_water_volume} L` : "—"}
        />
        <Field label="Water pH" value={wo.custom_water_ph ?? "—"} />
        <Field
          label="Hardness"
          value={
            wo.custom_water_hardness ? `${wo.custom_water_hardness} ppm` : "—"
          }
        />
        <Field label="Kit" value={wo.custom_kit ?? "—"} />
        <Field label="CSU / WIP" value={wo.wip_warehouse ?? "—"} />
        <Field label="Created" value={fmtCreation(wo.creation)} />
      </div>

      {items.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Chemicals ({items.length})
          </div>
          <div className="overflow-hidden rounded-md border bg-background">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Item Name</th>
                  <th className="px-3 py-1.5 text-left font-medium">Item Code</th>
                  <th className="px-3 py-1.5 text-right font-medium">Qty</th>
                  <th className="px-3 py-1.5 text-left font-medium">UoM</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={`${it.item_code}-${i}`} className="border-t">
                    <td className="px-3 py-1.5">{it.item_name || it.item_code}</td>
                    <td className="px-3 py-1.5 text-xs text-muted-foreground">
                      {it.item_code}
                    </td>
                    <td className="px-3 py-1.5 text-right font-semibold">
                      {fmtQty(it.required_qty)}
                    </td>
                    <td className="px-3 py-1.5">{it.stock_uom || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {targets.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Targets
          </div>
          <div className="flex flex-wrap gap-1.5">
            {targets.map((t) => (
              <span
                key={t}
                className="inline-flex items-center rounded-full bg-background px-2.5 py-0.5 text-xs font-medium ring-1 ring-border"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
