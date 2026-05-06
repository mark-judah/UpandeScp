import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

interface StockBalanceTableProps {
  balances: Record<string, Record<string, number>>
  warehouses: string[]
  itemNameMap: Record<string, string>
  sourceWarehouse: Record<string, string>
  onSourceChange: (itemCode: string, warehouse: string) => void
}

export function StockBalanceTable({
  balances,
  warehouses,
  itemNameMap,
  sourceWarehouse,
  onSourceChange,
}: StockBalanceTableProps) {
  const items = Object.keys(balances).sort()

  if (items.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
        No chemicals selected
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="min-w-full divide-y text-sm">
        <thead className="bg-muted/50">
          <tr>
            <th rowSpan={2} className="px-3 py-2 text-left font-medium">
              Chemical
            </th>
            <th colSpan={warehouses.length} className="border-l px-3 py-1.5 text-center font-medium">
              Warehouses
            </th>
            <th rowSpan={2} className="border-l px-3 py-2 text-center font-medium">
              Source
            </th>
            <th rowSpan={2} className="border-l px-3 py-2 text-center font-medium">
              Total
            </th>
          </tr>
          <tr>
            {warehouses.map((wh) => (
              <th
                key={wh}
                className="border-l border-t px-2 py-1 text-center text-xs font-normal text-muted-foreground"
                title={wh}
              >
                {wh.split(" - ")[0]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((code) => {
            const row = balances[code] ?? {}
            const total = warehouses.reduce((acc, wh) => acc + (row[wh] ?? 0), 0)
            return (
              <tr key={code}>
                <td className="px-3 py-2 font-medium">{itemNameMap[code] || code}</td>
                {warehouses.map((wh) => {
                  const qty = row[wh] ?? 0
                  return (
                    <td
                      key={wh}
                      className={cn(
                        "border-l px-2 py-2 text-center text-xs tabular-nums",
                        qty === 0 ? "text-muted-foreground" : "",
                      )}
                    >
                      {qty.toFixed(2)}
                    </td>
                  )
                })}
                <td className="border-l px-2 py-2">
                  <Select
                    value={sourceWarehouse[code] ?? ""}
                    onValueChange={(v) => onSourceChange(code, v ?? "")}
                  >
                    <SelectTrigger className="h-8 w-full">
                      <SelectValue placeholder="Select source" />
                    </SelectTrigger>
                    <SelectContent>
                      {warehouses.map((wh) => (
                        <SelectItem key={wh} value={wh}>
                          {wh.split(" - ")[0]} ({(row[wh] ?? 0).toFixed(2)})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td
                  className={cn(
                    "border-l px-3 py-2 text-center text-sm tabular-nums",
                    total === 0 ? "text-destructive" : "font-medium",
                  )}
                >
                  {total.toFixed(2)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
