/**
 * A compact floating control at the top-left of a map, under the zoom
 * buttons: where a page's legend / layer toggles / show-hide list lives now
 * that maps are full width with no docked rail. Collapses to its title row.
 * Place inside the map's `relative` container.
 */
import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function MapControlPanel({
  title,
  count,
  children,
  defaultOpen = true,
  className,
  testId = "map-control-panel",
}: {
  title: ReactNode;
  count?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Override the position (default sits under Leaflet's zoom + basemap
   *  buttons; MapLibre maps keep their zoom at top-right, so pass `top-3`). */
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      data-testid={testId}
      className={cn(
        "absolute left-3 top-[9.5rem] z-[1000] w-[min(240px,calc(100%-5rem))] rounded-2xl border bg-card/95 shadow-[var(--sd-shadow-1)] backdrop-blur",
        className,
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground"
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {count != null ? <span className="tabular-nums font-normal">{count}</span> : null}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open ? <div className="max-h-[min(45vh,22rem)] overflow-auto border-t p-2">{children}</div> : null}
    </div>
  );
}
