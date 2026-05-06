import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { AlertTriangle } from "lucide-react"

interface ValidationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  errors: string[]
  onBypass: () => void
}

export function ValidationDialog({
  open,
  onOpenChange,
  errors,
  onBypass,
}: ValidationDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-amber-600" />
            FRAC/IRAC Validation Warning
          </DialogTitle>
          <DialogDescription>
            The following guidelines were flagged for this spray plan.
          </DialogDescription>
        </DialogHeader>

        {errors.length > 0 ? (
          <ul className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
            {errors.map((e, i) => (
              <li key={i} className="text-sm text-destructive">
                {e}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No specific validation details provided.
          </p>
        )}

        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950/40">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Do you want to bypass these guidelines and create the Work Order anyway?
          </p>
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
            Bypassing may lead to reduced effectiveness and increased resistance.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onBypass}>Bypass and Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
