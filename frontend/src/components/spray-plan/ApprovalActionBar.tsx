import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, XCircle, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

const plans = (n: number) => `${n} plan${n === 1 ? "" : "s"}`;

/** The three button captions, worded for the current selection. */
export function actionCaptions(n: number) {
  return {
    approve: `Send ${plans(n)} to the store`,
    quick: "Skip the review",
    stop: `Cancel ${n === 1 ? "this plan" : `these ${n} plans`}`,
  };
}

/**
 * The approver's actions in an undocked pill floating at the bottom centre.
 * It exists only while something is selected and eases in and out; each button
 * is softly rounded and carries a one-line caption saying what it will do.
 */
export function ApprovalActionBar({
  count,
  busy,
  bulkBusy,
  stopConfirm,
  onApprove,
  onQuick,
  onStop,
  onConfirmStop,
  onCancelStop,
}: {
  count: number;
  busy: boolean;
  bulkBusy: boolean;
  stopConfirm: boolean;
  onApprove: () => void;
  onQuick: () => void;
  onStop: () => void;
  onConfirmStop: () => void;
  onCancelStop: () => void;
}) {
  const want = count > 0;
  const [mounted, setMounted] = useState(want);
  const [shown, setShown] = useState(false);
  const [last, setLast] = useState(count);
  useEffect(() => {
    if (want) {
      setLast(count);
      setMounted(true);
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const id = window.setTimeout(() => setMounted(false), 220);
    return () => window.clearTimeout(id);
  }, [want, count]);
  if (!mounted) return null;

  const n = want ? count : last;
  const cap = actionCaptions(n);
  const off = busy || bulkBusy;
  const btn =
    "flex min-w-[9.5rem] flex-col items-start gap-0.5 rounded-2xl border px-3.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30";
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-30 flex justify-center px-4">
      <div
        role="toolbar"
        aria-label="Selected plans"
        data-testid="approval-action-bar"
        data-state={shown ? "open" : "closed"}
        className={cn(
          "pointer-events-auto flex max-w-full flex-wrap items-center gap-3 rounded-full border bg-card/95 py-2 pl-5 pr-2 shadow-lg backdrop-blur transition-all duration-200 ease-out",
          shown ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
        )}
      >
        <div className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">{n}</span> selected
        </div>
        {stopConfirm ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Stop {plans(n)}? This cannot be undone.</span>
            <button type="button" onClick={onConfirmStop} className="rounded-xl bg-destructive px-3 py-1.5 font-medium text-destructive-foreground">
              Confirm
            </button>
            <button type="button" onClick={onCancelStop} className="rounded-xl px-3 py-1.5 font-medium text-muted-foreground hover:bg-muted">
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={off} onClick={onStop} className={cn(btn, "bg-background text-destructive hover:bg-muted")}>
              <span className="flex items-center gap-1.5 text-xs font-semibold">
                <XCircle className="h-3.5 w-3.5" /> Stop selected
              </span>
              <span className="text-[0.62rem] font-normal text-muted-foreground">{cap.stop}</span>
            </button>
            <button type="button" disabled={off} onClick={onQuick} className={cn(btn, "bg-background hover:bg-muted")}>
              <span className="flex items-center gap-1.5 text-xs font-semibold">
                {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />} Quick approve
              </span>
              <span className="text-[0.62rem] font-normal text-muted-foreground">{cap.quick}</span>
            </button>
            <button type="button" disabled={off} onClick={onApprove} className={cn(btn, "border-foreground bg-foreground text-background hover:bg-foreground/90")}>
              <span className="flex items-center gap-1.5 text-xs font-semibold">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Approve selected
              </span>
              <span className="text-[0.62rem] font-normal opacity-70">{cap.approve}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
