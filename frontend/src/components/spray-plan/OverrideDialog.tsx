/**
 * A GM gives a reason for each `Block (GM override)` violation still open on
 * a plan. The reasons are recorded on the plan with the GM's name.
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ruleLabel, type OverrideInput, type Violation } from "@/lib/spray-compliance-api";

export function OverrideDialog({
  open,
  onOpenChange,
  violations,
  onConfirm,
  confirmLabel = "Override and save",
  busy = false,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  violations: Violation[];
  onConfirm: (o: OverrideInput[]) => void;
  confirmLabel?: string;
  busy?: boolean;
}) {
  const pending = violations.filter((v) => v.mode === "Block (GM override)" && !v.overridden);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) setReasons({});
  }, [open]);
  const ready = pending.length > 0 && pending.every((v) => (reasons[v.key] ?? "").trim().length >= 5);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Override spray check</DialogTitle>
          <DialogDescription>Each override is recorded on the plan with your name and reason.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 max-h-[60vh] overflow-auto">
          {pending.map((v) => (
            <label key={v.key} className="flex flex-col gap-1 text-xs">
              <span className="font-medium">{ruleLabel(v.rule)}</span>
              <span className="text-muted-foreground">{v.message}</span>
              <Textarea
                rows={2}
                value={reasons[v.key] ?? ""}
                placeholder="Why this is acceptable for this spray"
                onChange={(e) => setReasons((r) => ({ ...r, [v.key]: e.target.value }))}
              />
            </label>
          ))}
          {!pending.length && (
            <span className="text-xs text-muted-foreground">Nothing on this plan needs an override.</span>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!ready || busy}
            onClick={() =>
              onConfirm(pending.map((v) => ({ key: v.key, rule: v.rule, reason: reasons[v.key].trim() })))
            }
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
