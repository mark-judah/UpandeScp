import { RefreshCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import type { SpaFilters } from "./types"

interface Props {
  filters: SpaFilters
  farms: string[]
  greenhouses: string[]
  busy: boolean
  onChange: (next: Partial<SpaFilters>) => void
  onLoad: () => void
  onClear: () => void
}

const ALL = "__all__"

export function FiltersBar({
  filters,
  farms,
  greenhouses,
  busy,
  onChange,
  onLoad,
  onClear,
}: Props) {
  const handleDateKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") onLoad()
  }

  return (
    <div className="flex flex-wrap items-end gap-3 border-b bg-background px-4 py-3 sm:px-6">
      <div className="space-y-1">
        <Label htmlFor="spa-from" className="text-xs">
          From
        </Label>
        <Input
          id="spa-from"
          type="date"
          value={filters.fromDate}
          onChange={(e) => onChange({ fromDate: e.target.value })}
          onBlur={onLoad}
          onKeyDown={handleDateKey}
          className="w-[160px]"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="spa-to" className="text-xs">
          To
        </Label>
        <Input
          id="spa-to"
          type="date"
          value={filters.toDate}
          onChange={(e) => onChange({ toDate: e.target.value })}
          onBlur={onLoad}
          onKeyDown={handleDateKey}
          className="w-[160px]"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Farm</Label>
        <Select
          value={filters.farm || ALL}
          onValueChange={(v) =>
            onChange({ farm: !v || v === ALL ? "" : v, greenhouse: "" })
          }
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All Farms" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Farms</SelectItem>
            {farms.map((f) => (
              <SelectItem key={f} value={f}>
                {f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Greenhouse</Label>
        <Select
          value={filters.greenhouse || ALL}
          onValueChange={(v) =>
            onChange({ greenhouse: !v || v === ALL ? "" : v })
          }
          disabled={!filters.farm || greenhouses.length === 0}
        >
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder={filters.farm ? "All" : "Select farm first"} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All</SelectItem>
            {greenhouses.map((gh) => (
              <SelectItem key={gh} value={gh}>
                {gh}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Button type="button" size="sm" onClick={onLoad} disabled={busy}>
          <RefreshCcw className={"mr-1 size-3.5 " + (busy ? "animate-spin" : "")} />
          Load
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClear} disabled={busy}>
          Clear
        </Button>
      </div>
    </div>
  )
}
