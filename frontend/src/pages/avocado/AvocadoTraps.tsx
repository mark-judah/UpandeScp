import { useEffect, useMemo, useState } from "react";
import { RowsSkeleton } from "@/components/Loading";
import { fetchTrapLocations, type TrapLocations } from "@/lib/scouting-api";
import { AvocadoTreeMap } from "./AvocadoTreeMap";
import type { AvocadoView } from "./tree-map-types";
import { deriveTrapMarkers, pestTotals } from "./derive-traps";
import { MapControlPanel } from "@/components/maps/MapControlPanel";
import { useObservationColors } from "@/lib/observation-colors";
import { TrapReadingCard } from "@/components/traps/TrapReadingCard";
import { trapPlacement } from "@/lib/trap-units";

export function AvocadoTraps({ crop }: { crop?: string } = {}) {
  // Fixed trap locations (Trap.geojson); traps without one fall back to the
  // average of their entries' coordinates.
  const [fixed, setFixed] = useState<TrapLocations>({});
  useEffect(() => {
    let cancelled = false;
    fetchTrapLocations().then((r) => {
      if (!cancelled) setFixed(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const { pest: pestColor } = useObservationColors();
  const view = useMemo<AvocadoView>(
    () => ({
      title: "Traps",
      subtitle: "Orchard trees · colour = pest · size, pulse and sides = catches",
      // Trees stay plain (unscouted colour); trap catches are the signal.
      deriveColors: () => new Map<string, string>(),
      deriveMarkers: (data) => deriveTrapMarkers(data, fixed, pestColor),
      trapUnits: fixed,
      markerCard: (m, range, onClose) =>
        m.label ? (
          <TrapReadingCard
            key={m.label}
            trap={m.label}
            from={range.from}
            to={range.to}
            local={m.latest}
            details={[
              { label: "Catches in range", value: m.count },
              {
                label: "Placement",
                value: trapPlacement(fixed[m.label]),
              },
            ]}
            onClose={onClose}
          />
        ) : null,
      renderLegend: (data, loading) => {
        const totals = pestTotals(deriveTrapMarkers(data, fixed, pestColor));
        return (
          <MapControlPanel
            title="Pests in view"
            count={loading ? undefined : totals.length}
          >
            {loading ? (
              <RowsSkeleton rows={4} />
            ) : totals.length === 0 ? (
              <div className="text-[0.72rem] text-muted-foreground">No pest data</div>
            ) : (
              <div className="flex flex-col gap-1">
                {totals.map((t) => (
                  <div key={t.pest} className="flex items-center gap-2 text-[0.72rem] text-foreground/80">
                    <span className="h-3.5 w-3.5 shrink-0 rounded-full border" style={{ background: pestColor(t.pest) }} />
                    <span className="flex-1 truncate">{t.pest}</span>
                    <span className="tabular-nums text-muted-foreground">{t.count}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-3 border-t pt-2 text-[0.65rem] text-muted-foreground">
              Size and pulse show how many were caught; sides, the biggest single catch.
            </div>
          </MapControlPanel>
        );
      },
      panelTitle: "Traps",
      renderPanel: (data, loading) => {
        const traps = deriveTrapMarkers(data, fixed, pestColor);
        return (
          <>
            <div className="space-y-0.5">
              {loading ? (
                <RowsSkeleton rows={6} />
              ) : traps.length ? (
                traps.map((t) => (
                  <div key={t.label} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ background: t.count > 0 ? t.color : undefined }} aria-hidden />
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
    [fixed, pestColor],
  );

  return <AvocadoTreeMap view={view} crop={crop} />;
}
