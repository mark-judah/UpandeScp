import { useEffect, useMemo, useState } from "react";
import { AvocadoTreeMap } from "./AvocadoTreeMap";
import type { AvocadoView } from "./tree-map-types";
import { deriveScoutColors, deriveScoutRoster } from "./derive-scouts";
import { fetchScoutLookup } from "@/lib/scouting-api";

export function AvocadoScouting() {
  const [scoutNames, setScoutNames] = useState<Record<string, string>>({});
  useEffect(() => {
    fetchScoutLookup().then(setScoutNames);
  }, []);
  const nameOf = (k: string) => scoutNames[k] || k;

  const view = useMemo<AvocadoView>(
    () => ({
      title: "Scouting Map",
      subtitle: "Orchard trees · per-scout coloring · click a block to fly in",
      showTracks: true,
      deriveColors: deriveScoutColors,
      renderPanel: (data) => {
        const roster = deriveScoutRoster(data);
        return (
          <>
            <div className="border-b px-3 py-2.5">
              <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                Scouts
              </div>
            </div>
            <div className="flex-1 min-h-0 space-y-0.5 overflow-y-auto p-2">
              <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ background: "#7c8b6a" }} aria-hidden />
                <span className="flex-1 truncate text-muted-foreground">Unscouted</span>
              </div>
              {roster.length ? (
                roster.map((s) => (
                  <div key={s.key} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ background: s.color }} aria-hidden />
                    <span className="flex-1 truncate" title={nameOf(s.key)}>{nameOf(s.key)}</span>
                    <span className="tabular-nums text-muted-foreground">{s.trees}</span>
                  </div>
                ))
              ) : (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No scouting this week</div>
              )}
            </div>
          </>
        );
      },
    }),
    [scoutNames],
  );

  return <AvocadoTreeMap view={view} />;
}
