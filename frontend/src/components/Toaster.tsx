import { CheckCircle2, AlertTriangle, Info, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastKind = "ok" | "err" | "warn" | "info" | "loading";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  /** The statement — one sentence, sentence case, ending in a full stop. */
  text: string;
  /** What to do about it. Sits under the statement, quieter. */
  hint?: string;
}

/** The icon carries the tone; the surface stays paper and the words stay ink.
 *  A red sentence on a red field is hard to read and shouts at someone who has
 *  merely left a field blank. */
const TONE: Record<ToastKind, { surface: string; icon: string }> = {
  ok: {
    surface: "bg-[var(--sd-data-green)]/[0.07] border-[var(--sd-data-green)]/25",
    icon: "text-[var(--sd-data-green)]",
  },
  err: {
    surface: "bg-[var(--sd-data-red)]/[0.06] border-[var(--sd-data-red)]/25",
    icon: "text-[var(--sd-data-red)]",
  },
  warn: {
    surface: "bg-[var(--sd-target)]/[0.10] border-[var(--sd-target)]/30",
    icon: "text-[var(--sd-target)]",
  },
  info: { surface: "bg-card border-[var(--sd-line)]", icon: "text-[var(--sd-quiet)]" },
  loading: { surface: "bg-card border-[var(--sd-line)]", icon: "text-[var(--sd-quiet)]" },
};

const ICON: Record<ToastKind, React.ComponentType<{ className?: string }>> = {
  ok: CheckCircle2,
  err: AlertTriangle,
  warn: AlertTriangle,
  info: Info,
  loading: Loader2,
};

/**
 * Inline toaster strip pinned under the page header. Stacks messages and
 * auto-dismisses non-loading ones via the parent's state.
 *
 * Every message is a statement — a full sentence, sentence case, ending in a
 * full stop — with the instruction, if there is one, on a quieter second line.
 * Server errors should be passed through `errorText` / `explainError` first so
 * the sentence is one a farm manager can act on rather than the Python that
 * happened to be raised.
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
    <div className="sticky top-[60px] z-30 flex flex-col gap-2 px-4 md:px-6 py-2.5 bg-card/90 backdrop-blur border-b">
      {items.map((t) => {
        const I = ICON[t.kind];
        const tone = TONE[t.kind];
        return (
          <div
            key={t.id}
            role={t.kind === "err" ? "alert" : "status"}
            className={cn(
              "rounded-[var(--sd-radius-lg)] border px-3.5 py-2.5 flex items-start gap-2.5",
              "shadow-[0_1px_2px_rgba(10,10,10,0.04)]",
              tone.surface,
            )}
          >
            <I
              className={cn(
                "h-4 w-4 shrink-0 mt-px",
                tone.icon,
                t.kind === "loading" && "animate-spin",
              )}
            />
            <div className="flex-1 min-w-0">
              <p className="text-[0.78rem] leading-snug text-foreground">{t.text}</p>
              {t.hint && (
                <p className="mt-0.5 text-[0.7rem] leading-snug text-muted-foreground">
                  {t.hint}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              className="shrink-0 -mr-1 -mt-0.5 rounded-full p-1 opacity-50 hover:opacity-100 hover:bg-[var(--sd-line)] transition"
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
