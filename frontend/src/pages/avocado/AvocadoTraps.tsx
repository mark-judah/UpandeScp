import { useMemo } from "react";
import { AvocadoTreeMap } from "./AvocadoTreeMap";
import type { AvocadoView } from "./tree-map-types";
import { deriveTrapMarkers } from "./derive-traps";

export function AvocadoTraps() {
  const view = useMemo<AvocadoView>(
    () => ({
      title: "Traps",
      subtitle: "Orchard trees · trap catches sized by count",
      // Trees stay plain (unscouted colour); trap catches are the signal.
      deriveColors: () => new Map<string, string>(),
      deriveMarkers: deriveTrapMarkers,
      renderPanel: (data) => {
        const traps = deriveTrapMarkers(data);
        return (
          <>
            <div className="border-b px-3 py-2.5">
              <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                Traps
              </div>
            </div>
            <div className="flex-1 min-h-0 space-y-0.5 overflow-y-auto p-2">
              {traps.length ? (
                traps.map((t) => (
                  <div key={t.label} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ background: t.color }} aria-hidden />
                    <span className="flex-1 truncate" title={t.label}>{t.label}</span>
                    <span className="tabular-nums text-muted-foreground">{t.count}</span>
                  </div>
                ))
              ) : (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No trap catches this week</div>
              )}
            </div>
          </>
        );
      },
    }),
    [],
  );

  return <AvocadoTreeMap view={view} />;
}
