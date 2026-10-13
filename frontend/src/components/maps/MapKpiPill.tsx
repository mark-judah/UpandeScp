import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The quiet totals pill at the top centre of a map. Place inside the map's
 *  `relative` container. */
export function MapKpiPill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-testid="map-kpi-pill"
      className={cn(
        "pointer-events-none absolute left-1/2 top-3 z-[1000] max-w-[calc(100%-9rem)] -translate-x-1/2 truncate rounded-full border bg-card/95 px-3 py-1 text-[0.7rem] tabular-nums shadow-[var(--sd-shadow-1)] backdrop-blur",
        className,
      )}
    >
      {children}
    </div>
  );
}
