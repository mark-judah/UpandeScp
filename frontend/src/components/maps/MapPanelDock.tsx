/**
 * The single place floating map panels live: a column anchored to the
 * BOTTOM-RIGHT of the map (clear of the top zoom buttons and the small
 * bottom-left credit), stacking its children vertically with a gap, capped to
 * the map's height. On a phone it becomes a full-width bottom stack.
 * Panels (MapControlPanel, MapFloatingCard) rendered inside it flow in the
 * column instead of positioning themselves. Place inside the map's `relative`
 * container; put list/legend panels first and detail cards last.
 */
import { createContext, useContext, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const DockContext = createContext(false);

/** True when rendered inside a MapPanelDock (panels then flow, not float). */
export const useInMapPanelDock = () => useContext(DockContext);

export const MAP_PANEL_DOCK_CLASS = [
  "pointer-events-none absolute bottom-4 right-4 z-[1000] flex flex-col items-end gap-2",
  "max-h-[calc(100%-5rem)] min-h-0",
  "[&>*]:pointer-events-auto [&>*]:shrink-0",
  // phone: full-width bottom stack
  "max-sm:bottom-2 max-sm:left-2 max-sm:right-2 max-sm:items-stretch max-sm:[&>*]:!w-full",
].join(" ");

export function MapPanelDock({
  children,
  className,
  testId = "map-panel-dock",
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <DockContext.Provider value>
      <div data-testid={testId} className={cn(MAP_PANEL_DOCK_CLASS, className)}>
        {children}
      </div>
    </DockContext.Provider>
  );
}
