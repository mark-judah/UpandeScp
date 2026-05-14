import { CheckCircle2, Square } from "lucide-react"

import { Button } from "@/components/ui/button"

interface Props {
  selectedCount: number
  busy: boolean
  stopConfirmOpen: boolean
  onApprove: () => void
  onStopClick: () => void
  onConfirmStop: () => void
  onDismissStop: () => void
}

export function ActionBar({
  selectedCount,
  busy,
  stopConfirmOpen,
  onApprove,
  onStopClick,
  onConfirmStop,
  onDismissStop,
}: Props) {
  const disabled = busy || selectedCount === 0

  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t bg-background px-4 py-3 sm:px-6">
      <div className="text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">{selectedCount}</span> selected
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {stopConfirmOpen && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-sm">
            <span className="text-destructive">
              Stop {selectedCount} work order{selectedCount !== 1 ? "s" : ""}? This cannot be undone.
            </span>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={onConfirmStop}
              disabled={busy}
            >
              Confirm
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onDismissStop}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={onStopClick}
          disabled={disabled}
          className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Square className="mr-1 size-3.5 fill-current" />
          Stop Selected
        </Button>
        <Button
          type="button"
          onClick={onApprove}
          disabled={disabled}
          className="bg-emerald-600 text-white hover:bg-emerald-700"
        >
          <CheckCircle2 className="mr-1 size-3.5" />
          Approve Selected
        </Button>
      </div>
    </div>
  )
}
