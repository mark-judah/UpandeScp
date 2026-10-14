/**
 * The one detail card every map page uses: an undocked floating card at the
 * bottom-right of the map, with an eyebrow + title, a close button and Esc to
 * close. Place it inside the map's `relative` container.
 */
import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Calls `onClose` when Escape is pressed while `active`. */
export function useEscapeClose(onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, active]);
}

export interface MapFloatingCardProps {
  title: ReactNode;
  eyebrow?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  className?: string;
  /** aria-label for the dialog (defaults to a string title). */
  label?: string;
  /** aria-label for the close button. */
  closeLabel?: string;
  testId?: string;
}

export function MapFloatingCard({
  title,
  eyebrow,
  onClose,
  children,
  className,
  label,
  closeLabel = "Close card",
  testId = "map-floating-card",
}: MapFloatingCardProps) {
  useEscapeClose(onClose);
  return (
    <div
      role="dialog"
      aria-label={label ?? (typeof title === "string" ? title : undefined)}
      data-testid={testId}
      className={cn(
        "absolute bottom-4 right-4 z-[1000]",
        "max-h-[calc(100%-2rem)] w-[min(320px,calc(100%-2rem))] overflow-auto rounded-2xl border bg-card/95 p-4 shadow-[var(--sd-shadow-2,0_8px_24px_rgba(0,0,0,0.18))] backdrop-blur",
        "scp-card-in",
        className,
      )}
    >
      <div className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {eyebrow ? (
            <div className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">{eyebrow}</div>
          ) : null}
          <div className="truncate text-sm font-semibold">{title}</div>
        </div>
        <button
          type="button"
          aria-label={closeLabel}
          onClick={onClose}
          className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {children}
    </div>
  );
}
