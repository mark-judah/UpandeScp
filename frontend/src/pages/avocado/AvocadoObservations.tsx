import { useMemo, useState } from "react";
import { AvocadoTreeMap } from "./AvocadoTreeMap";
import type { AvocadoView } from "./tree-map-types";
import { deriveObservationColors, deriveObservationRoster } from "./derive-observations";
import { useObservationColors, type ObsKind } from "@/lib/observation-colors";
import { HEADER_PILL } from "@/components/header-controls";

export function AvocadoObservations() {
  const [kind, setKind] = useState<ObsKind>("pest");
  const { pest: pestColor, disease: diseaseColor } = useObservationColors();

  const view = useMemo<AvocadoView>(() => {
    const colorOf = (name: string) => (kind === "disease" ? diseaseColor(name) : pestColor(name));
    return {
      title: "Observations",
      subtitle: "Orchard trees · tinted by the dominant pest / disease observed",
      deriveColors: (data) => deriveObservationColors(data, kind, colorOf),
      headerControls: (
        <div className={`${HEADER_PILL} gap-0 overflow-hidden !p-0`}>
          {(["pest", "disease"] as ObsKind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`px-3 py-1 text-xs capitalize ${kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
            >
              {k === "pest" ? "Pests" : "Diseases"}
            </button>
          ))}
        </div>
      ),
      renderPanel: (data) => {
        const roster = deriveObservationRoster(data, kind);
        return (
          <>
            <div className="border-b px-3 py-2.5">
              <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                {kind === "pest" ? "Pests" : "Diseases"}
              </div>
            </div>
            <div className="flex-1 min-h-0 space-y-0.5 overflow-y-auto p-2">
              {roster.length ? (
                roster.map((o) => (
                  <div key={o.name} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ background: colorOf(o.name) }} aria-hidden />
                    <span className="flex-1 truncate" title={o.name}>{o.name}</span>
                    <span className="tabular-nums text-muted-foreground">{o.count}</span>
                  </div>
                ))
              ) : (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No {kind === "pest" ? "pests" : "diseases"} this week</div>
              )}
            </div>
          </>
        );
      },
    };
  }, [kind, pestColor, diseaseColor]);

  return <AvocadoTreeMap view={view} />;
}
