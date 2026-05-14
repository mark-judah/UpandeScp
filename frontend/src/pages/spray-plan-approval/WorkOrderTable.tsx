import { Fragment } from "react"
import { ChevronDown, ExternalLink } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

import { WorkOrderDetails } from "./WorkOrderDetails"
import { fmtScheduledDate } from "./utils"
import type { WorkOrder } from "./types"

interface Props {
  wos: WorkOrder[]
  checked: Set<string>
  expanded: Set<string>
  onToggleCheck: (name: string) => void
  onToggleAll: (checked: boolean) => void
  onToggleExpand: (name: string) => void
}

function StatusBadge({ isForwarded }: { isForwarded?: boolean }) {
  if (isForwarded) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        Forwarded
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
      <span className="size-1.5 rounded-full bg-amber-500" />
      Pending
    </span>
  )
}

export function WorkOrderTable({
  wos,
  checked,
  expanded,
  onToggleCheck,
  onToggleAll,
  onToggleExpand,
}: Props) {
  const checkedInView = wos.filter((w) => checked.has(w.name)).length
  const allChecked = wos.length > 0 && checkedInView === wos.length
  const someChecked = checkedInView > 0 && checkedInView < wos.length

  return (
    <div className="rounded-md border bg-background">
      <div className="flex items-center gap-3 border-b px-3 py-2">
        <Checkbox
          checked={allChecked}
          indeterminate={someChecked}
          onCheckedChange={(v) => onToggleAll(v === true)}
          aria-label="Select all"
        />
        <span className="text-sm font-medium">
          {wos.length} work order{wos.length !== 1 ? "s" : ""}
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10" />
            <TableHead>Work Order</TableHead>
            <TableHead>Greenhouse</TableHead>
            <TableHead>Scheduled</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-center">Chemicals</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {wos.map((wo) => {
            const isChecked = checked.has(wo.name)
            const isOpen = expanded.has(wo.name)
            const chemCount = (wo.required_items ?? []).length
            return (
              <Fragment key={wo.name}>
                <TableRow
                  className={cn(isChecked && "bg-muted/40")}
                  onClick={(e) => {
                    const t = e.target as HTMLElement
                    if (
                      t.tagName === "INPUT" ||
                      t.closest("a") ||
                      t.closest("button") ||
                      t.closest("[role='checkbox']")
                    ) {
                      return
                    }
                    onToggleCheck(wo.name)
                  }}
                >
                  <TableCell>
                    <Checkbox
                      checked={isChecked}
                      onCheckedChange={() => onToggleCheck(wo.name)}
                      aria-label={`Select ${wo.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <a
                      href={`/app/work-order/${encodeURIComponent(wo.name)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                    >
                      {wo.name}
                      <ExternalLink className="size-3" />
                    </a>
                  </TableCell>
                  <TableCell>{wo.custom_greenhouse || "—"}</TableCell>
                  <TableCell>
                    <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium">
                      {fmtScheduledDate(wo.custom_scheduled_application_time)}
                    </span>
                  </TableCell>
                  <TableCell>
                    {wo.custom_spray_type ? (
                      <span className="inline-flex rounded-md bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800 dark:bg-sky-500/15 dark:text-sky-200">
                        {wo.custom_spray_type}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs font-medium">
                      {chemCount}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge isForwarded={wo.is_forwarded} />
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      className={cn(
                        "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-transform hover:bg-muted hover:text-foreground",
                        isOpen && "rotate-180",
                      )}
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggleExpand(wo.name)
                      }}
                      aria-label={isOpen ? "Hide details" : "Show details"}
                    >
                      <ChevronDown className="size-4" />
                    </button>
                  </TableCell>
                </TableRow>
                {isOpen && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={8} className="p-3">
                      <WorkOrderDetails wo={wo} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
