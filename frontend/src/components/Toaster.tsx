import { CheckCircle2, AlertTriangle, Info, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastKind = "ok" | "err" | "warn" | "info" | "loading";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

const TONE: Record<ToastKind, string> = {
  ok: "border-[var(--sd-data-green)]/40 text-[var(--sd-data-green)] bg-[var(--sd-data-green)]/8",
  err: "border-[var(--sd-data-red)]/40 text-[var(--sd-data-red)] bg-[var(--sd-data-red)]/8",
  warn: "border-amber-500/40 text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/30",
  info: "border-[var(--sd-line)] text-foreground bg-card",
  loading: "border-[var(--sd-line)] text-muted-foreground bg-card",
};

const ICON: Record<ToastKind, React.ComponentType<{ className?: string }>> = {
  ok: CheckCircle2,
  err: AlertTriangle,
  warn: AlertTriangle,
  info: Info,
  loading: Loader2,
};

/**
 * Inline toaster strip pinned to the top of the page header. Stacks
 * messages, auto-dismisses non-loading ones via the parent state. Used by
 * Application Plan to surface validation errors and submission progress
 * without bumping the layout around.
 */
export function Toaster({
  items,
  onDismiss,
}: {
  items: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="sticky top-[60px] z-30 flex flex-col gap-1.5 px-4 md:px-6 py-2 bg-card/90 backdrop-blur border-b">
      {items.map((t) => {
        const I = ICON[t.kind];
        return (
          <div
            key={t.id}
            className={cn(
              "rounded-md border px-3 py-2 text-xs flex items-center gap-2",
              TONE[t.kind],
            )}
          >
            <I
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                t.kind === "loading" && "animate-spin",
              )}
            />
            <span className="flex-1">{t.text}</span>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              className="opacity-60 hover:opacity-100"
              aria-label="Dismiss"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
