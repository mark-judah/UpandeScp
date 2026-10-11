import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * What just happened, said without moving the page — the same toast as the
 * Livestock app, which takes it from Frappe's desk alert, so a message from SCP,
 * from Livestock and from the desk are recognisably the same object.
 *
 * It floats bottom right (across the bottom on a phone) instead of the old strip
 * pinned under the header, which pushed the page down the moment a button
 * answered.
 *
 * ONLY WHAT JUST HAPPENED. Anything you might need to read twice — a page that
 * failed to load, a plan the spray check blocks — stays inline.
 *
 * AN ERROR DOES NOT TIME OUT: a refusal carries instructions and must not vanish
 * while it is being read. A "loading" toast stays until its caller dismisses it.
 */

export type ToastKind = "ok" | "err" | "warn" | "info" | "loading";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  /** The statement — one sentence, sentence case, ending in a full stop. */
  text: string;
  /** What to do about it. Sits under the statement, quieter. */
  hint?: string;
}

/** Default lifetimes; 0 = stays until dismissed. */
const LIFETIME: Record<ToastKind, number> = { ok: 5000, info: 7000, warn: 9000, err: 0, loading: 0 };

/**
 * The panel is a wash of the tone (Frappe's --alert-bg-*) and the icon carries
 * the colour; the words stay ink at full contrast. No coloured strip down the edge.
 */
const TONES: Record<ToastKind, { accent: string; wash: string }> = {
  err: { accent: "var(--sd-sev-critical)", wash: "var(--sd-alert-error)" },
  warn: { accent: "var(--sd-sev-high)", wash: "var(--sd-alert-warn)" },
  ok: { accent: "var(--sd-sev-moderate)", wash: "var(--sd-alert-ok)" },
  info: { accent: "var(--sd-quiet)", wash: "var(--sd-alert-info)" },
  loading: { accent: "var(--sd-quiet)", wash: "var(--sd-alert-info)" },
};

const ICON: Record<ToastKind, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  ok: CheckCircle2,
  err: AlertTriangle,
  warn: AlertTriangle,
  info: Info,
  loading: Loader2,
};

export interface ToastApi {
  /** Say something; returns its id. `ms` overrides the lifetime (0 = sticky);
   *  errors never time out whatever is passed. */
  show: (text: string, kind?: ToastKind, opts?: { hint?: string; ms?: number }) => number;
  dismiss: (id: number) => void;
}

const NOOP: ToastApi = { show: () => 0, dismiss: () => {} };
const ToastContext = createContext<ToastApi>(NOOP);

/** Say something, from anywhere under the ToastProvider. */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const show = useCallback<ToastApi["show"]>(
    (text, kind = "ok", opts) => {
      const body = String(text ?? "");
      if (!body.trim()) return 0;
      const id = next.current++;
      // Three at once is a stack nobody reads; the oldest goes (a running
      // "loading" toast is kept — its caller will dismiss it).
      setToasts((all) => {
        const add = [...all, { id, kind, text: body, hint: opts?.hint }];
        while (add.length > 3) {
          const i = add.findIndex((t) => t.kind !== "loading");
          add.splice(i < 0 ? 0 : i, 1);
        }
        return add;
      });
      const ms = kind === "err" || kind === "loading" ? 0 : opts?.ms ?? LIFETIME[kind];
      if (ms) timers.current.set(id, setTimeout(() => dismiss(id), ms));
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const running = timers.current;
    return () => running.forEach(clearTimeout);
  }, []);

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        // Bottom right on a desktop, across the bottom on a phone.
        className="pointer-events-none fixed inset-x-3 bottom-3 z-[60] flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-[min(24rem,calc(100vw-2.5rem))]"
      >
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const Icon = ICON[toast.kind];
  const tone = TONES[toast.kind];
  return (
    <div
      // `alert` interrupts; a refusal earns it, a confirmation does not.
      role={toast.kind === "err" ? "alert" : "status"}
      data-kind={toast.kind}
      className={cn(
        "pointer-events-auto flex items-start gap-2.5 rounded-[var(--sd-radius-toast)] px-4 py-3.5",
        "text-[13px] leading-relaxed whitespace-pre-line shadow-[var(--sd-shadow-3)]",
        "sd-toast-in",
        "font-medium text-[var(--sd-ink)]",
      )}
      style={{ background: tone.wash }}
    >
      <Icon
        className={cn("mt-0.5 h-4 w-4 shrink-0", toast.kind === "loading" && "animate-spin")}
        style={{ color: tone.accent }}
      />
      <div className="min-w-0 flex-1">
        <p>{toast.text}</p>
        {toast.hint && (
          <p className="mt-0.5 text-xs font-normal text-[var(--sd-quiet)]">{toast.hint}</p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-mr-1 shrink-0 text-[var(--sd-quiet)] transition-colors hover:text-[var(--sd-ink)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
