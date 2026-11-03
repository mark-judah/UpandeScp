import { useEffect, useMemo, useState } from "react";
import { AvocadoTreeMap } from "./AvocadoTreeMap";
import type { AvocadoView } from "./tree-map-types";
import { deriveObservationRoster } from "./derive-observations";
import {
  SCALE_COLORS, SCALE_LABELS, UNSCOUTED_TONE, deriveMultiColors, deriveSingleColors, obsId, peakOf, scaleCuts, type Obs,
} from "./pest-colour";
import { ObservationPicker } from "./ObservationPicker";
import { useObservationColors, type ObsKind } from "@/lib/observation-colors";
import { observationOptions } from "@/lib/pest-heat";
import { getThresholds } from "@/lib/thresholds-api";
import { thresholdMapFromBundle, type MeasuredBand } from "@/lib/threshold-measure";
import { HEADER_PILL } from "@/components/header-controls";
import { ClearFiltersPill } from "@/components/ClearFiltersPill";
import { MapControlPanel } from "@/components/maps/MapControlPanel";
import { RowsSkeleton } from "@/components/Loading";
import { fetchRoundPerHa, perHaLabel, type PerHaSummary, type RoundPerHa } from "@/lib/cumulative-api";

type KindFilter = "all" | ObsKind;

/**
 * Open-field Observations: orchard trees, pivot hexagons and visit points.
 * No pick: every unit in the colour of its dominant pest / disease, intensity by level.
 * One pest or disease picked: units run green / amber / red by that observation's thresholds.
 */
export function AvocadoObservations({ crop }: { crop?: string } = {}) {
  const cropName = crop || "Avocado";
  const [kind, setKind] = useState<KindFilter>("all");
  /** Picked observation = single mode (green -> red). None = every pest in its own colour. */
  const [picked, setPicked] = useState<Obs | null>(null);
  const { pest: pestColor, disease: diseaseColor } = useObservationColors();
  // Cumulative per hectare over the current scouting round: the figure a block is
  // judged on (the unit counts below are only the sample). Crops not scouted by
  // block have none; the request is refused and the column simply stays empty.
  const [round, setRound] = useState<RoundPerHa | null>(null);
  useEffect(() => {
    let live = true;
    setRound(null);
    fetchRoundPerHa(cropName)
      .then((r) => live && setRound(r))
      .catch(() => live && setRound(null));
    return () => {
      live = false;
    };
  }, [cropName]);
  const perHa = useMemo(() => {
    const m = new Map<string, PerHaSummary>();
    for (const row of round?.summary ?? []) m.set(`${row.kind}|${row.observation}`, row);
    return m;
  }, [round]);
  const [bands, setBands] = useState<Map<string, MeasuredBand>>(new Map());

  useEffect(() => {
    let off = false;
    getThresholds(cropName)
      .then((b) => !off && setBands(thresholdMapFromBundle(b)))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [cropName]);

  const view = useMemo<AvocadoView>(() => {
    const colorOf = (o: Obs) => (o.kind === "disease" ? diseaseColor(o.name) : pestColor(o.name));
    const bandOf = (o: Obs) => bands.get(`${o.kind}::${o.name}::`) ?? null;
    const pick = (o: Obs) => setPicked((p) => (p && obsId(p) === obsId(o) ? null : o));
    return {
      title: "Observations",
      // Open-field observations are read from above: always 2D.
      flat: true,
      subtitle: picked
        ? `${picked.name} from low to high`
        : "Each unit in the colour of its dominant pest / disease",
      deriveColors: (data) =>
        picked
          ? deriveSingleColors(data, picked, bandOf(picked))
          : deriveMultiColors(data, (o) => (kind === "all" || kind === o.kind ? colorOf(o) : UNSCOUTED_TONE)),
      patchObservation: picked,
      headerControls: (
        <>
          <div className={`${HEADER_PILL} gap-0 overflow-hidden !p-0`}>
            {(["all", "pest", "disease"] as KindFilter[]).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => {
                  setKind(k);
                  setPicked((p) => (p && k !== "all" && p.kind !== k ? null : p));
                }}
                className={`px-3 py-1 text-xs ${kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              >
                {k === "all" ? "All" : k === "pest" ? "Pests" : "Diseases"}
              </button>
            ))}
          </div>
          <ClearFiltersPill active={!!picked} onClear={() => setPicked(null)} label="Show all" />
        </>
      ),
      panelTitle: kind === "pest" ? "Pests" : kind === "disease" ? "Diseases" : "Pests and diseases",
      renderPanel: (data, loading) => {
        const rows = (["pest", "disease"] as ObsKind[])
          .filter((k) => kind === "all" || kind === k)
          .flatMap((k) => deriveObservationRoster(data, k).map((r) => ({ ...r, kind: k })))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        const opts = observationOptions(data?.entries || []).filter((o) => kind === "all" || o.kind === kind);
        const value = picked ? opts.find((o) => obsId(o) === obsId(picked)) ?? { ...picked, count: 0 } : null;
        return (
          <div className="space-y-0.5">
            <div className="pb-1">
              <ObservationPicker options={opts} value={value} onChange={(o) => setPicked({ kind: o.kind, name: o.name })} />
            </div>
            {round ? (
              <div className="px-2 pb-1 text-[0.65rem] text-muted-foreground">Per hectare, round {round.round.label}</div>
            ) : null}
            {loading ? (
              <RowsSkeleton rows={6} />
            ) : rows.length ? (
              rows.map((o) => {
                const on = !!picked && obsId(picked) === obsId(o);
                const ph = perHa.get(obsId(o));
                return (
                  <button
                    key={obsId(o)}
                    type="button"
                    aria-pressed={on}
                    title={on ? "Back to all colours" : `Show only ${o.name}, low to high`}
                    onClick={() => pick(o)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted ${on ? "bg-muted font-medium" : ""}`}
                  >
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full border" style={{ background: colorOf(o) }} aria-hidden />
                    <span className="flex-1 truncate" title={o.name}>{o.name}</span>
                    {kind === "all" ? (
                      <span className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">{o.kind}</span>
                    ) : null}
                    {ph?.per_ha != null ? (
                      <span className="tabular-nums text-muted-foreground" title="Cumulative this round, per hectare">{perHaLabel(ph.per_ha)}</span>
                    ) : null}
                    <span className="tabular-nums text-muted-foreground">{o.count}</span>
                  </button>
                );
              })
            ) : (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">No observations in this range</div>
            )}
          </div>
        );
      },
      renderLegend: (data, loading) => {
        if (loading) return null;
        if (!picked) {
          // Overview: one swatch per pest / disease that actually shows on the map.
          const seen = (["pest", "disease"] as ObsKind[])
            .filter((k) => kind === "all" || kind === k)
            .flatMap((k) => deriveObservationRoster(data, k).map((r) => ({ kind: k, name: r.name })));
          if (!seen.length) return null;
          return (
            <MapControlPanel title="Dominant pest / disease">
              <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                {seen.map((o) => (
                  <div key={obsId(o)} className="flex items-center gap-2 text-[0.72rem] text-foreground/80">
                    <span className="h-3.5 w-3.5 shrink-0 rounded-full border" style={{ background: colorOf(o) }} aria-hidden />
                    <span className="flex-1 truncate" title={o.name}>{o.name}</span>
                  </div>
                ))}
                <div className="text-[0.65rem] text-muted-foreground">Deeper colour = more of it on that unit</div>
              </div>
            </MapControlPanel>
          );
        }
        const cuts = scaleCuts(peakOf(data, picked), bandOf(picked));
        const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
        const ranges = [`below ${fmt(cuts.moderate)}`, `${fmt(cuts.moderate)} to ${fmt(cuts.high)}`, `${fmt(cuts.high)} and above`];
        return (
          <MapControlPanel title={`${picked.name} level`}>
            <div className="flex flex-col gap-1">
              {SCALE_LABELS.map((l, i) => (
                <div key={l} className="flex items-center gap-2 text-[0.72rem] text-foreground/80">
                  <span className="h-3.5 w-3.5 shrink-0 rounded-full border" style={{ background: SCALE_COLORS[i] }} aria-hidden />
                  <span className="flex-1">{l}</span>
                  <span className="tabular-nums text-muted-foreground">{ranges[i]}</span>
                </div>
              ))}
              <div className="text-[0.65rem] text-muted-foreground">
                {cuts.fromThreshold ? "Counts per unit, from this pest's thresholds" : "Counts per unit, thirds of the highest unit"}
              </div>
            </div>
          </MapControlPanel>
        );
      },
    };
  }, [kind, picked, bands, perHa, round, pestColor, diseaseColor]);

  return <AvocadoTreeMap view={view} crop={crop} />;
}
