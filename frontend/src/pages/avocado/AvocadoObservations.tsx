import { useEffect, useMemo, useState } from "react";
import { AvocadoTreeMap } from "./AvocadoTreeMap";
import type { AvocadoView } from "./tree-map-types";
import { deriveObservationRoster } from "./derive-observations";
import {
  SCALE_COLORS, SCALE_LABELS, deriveMultiColors, deriveSingleColors, obsId, peakOf, scaleCuts, type Obs,
} from "./pest-colour";
import { ObservationPicker } from "./ObservationPicker";
import { useObservationColors, type ObsKind } from "@/lib/observation-colors";
import { observationOptions } from "@/lib/pest-heat";
import { takeHotSpotFocus } from "@/lib/hot-spot-focus";
import { getThresholds } from "@/lib/thresholds-api";
import { thresholdMapFromBundle, type MeasuredBand } from "@/lib/threshold-measure";
import { HEADER_PILL } from "@/components/header-controls";
import { ClearFiltersPill } from "@/components/ClearFiltersPill";
import { MapControlPanel } from "@/components/maps/MapControlPanel";
import { RowsSkeleton } from "@/components/Loading";
import { fetchRoundPerHa, perHaLabel, type PerHaSummary, type RoundPerHa } from "@/lib/cumulative-api";

type KindFilter = "all" | ObsKind;

export function AvocadoObservations() {
  const [kind, setKind] = useState<KindFilter>("all");
  /** Picked observation = single mode (green -> red). None = every pest in its own colour. */
  // Arriving from a hot spot's "Show on map": its observation is picked and its block focused.
  const [focus] = useState(() => takeHotSpotFocus());
  const [picked, setPicked] = useState<Obs | null>(focus ? { kind: focus.kind, name: focus.observation } : null);
  const { pest: pestColor, disease: diseaseColor } = useObservationColors();
  // Cumulative per hectare over the current scouting round: the figure an
  // orchard block is judged on (the tree counts below are only the sample).
  const [round, setRound] = useState<RoundPerHa | null>(null);
  useEffect(() => {
    let live = true;
    fetchRoundPerHa("Avocado")
      .then((r) => live && setRound(r))
      .catch(() => live && setRound(null));
    return () => {
      live = false;
    };
  }, []);
  const perHa = useMemo(() => {
    const m = new Map<string, PerHaSummary>();
    for (const row of round?.summary ?? []) m.set(`${row.kind}|${row.observation}`, row);
    return m;
  }, [round]);
  const [bands, setBands] = useState<Map<string, MeasuredBand>>(new Map());

  useEffect(() => {
    let off = false;
    getThresholds("Avocado")
      .then((b) => !off && setBands(thresholdMapFromBundle(b)))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, []);

  const view = useMemo<AvocadoView>(() => {
    const colorOf = (o: Obs) => (o.kind === "disease" ? diseaseColor(o.name) : pestColor(o.name));
    const bandOf = (o: Obs) => bands.get(`${o.kind}::${o.name}::`) ?? null;
    const pick = (o: Obs) => setPicked((p) => (p && obsId(p) === obsId(o) ? null : o));
    return {
      title: "Observations",
      subtitle: picked
        ? `Orchard trees · ${picked.name} from low to high`
        : "Orchard trees · each in the colour of its dominant pest / disease",
      deriveColors: (data) =>
        picked
          ? deriveSingleColors(data, picked, bandOf(picked))
          : deriveMultiColors(data, (o) => (kind === "all" || kind === o.kind ? colorOf(o) : "#7c8b6a")),
      patchObservation: picked,
      focusBlock: focus?.block ?? null,
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
            {loading ? (
              <RowsSkeleton rows={6} />
            ) : rows.length ? (
              rows.map((o) => {
                const on = !!picked && obsId(picked) === obsId(o);
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
        if (!picked || loading) return null;
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
                {cuts.fromThreshold ? "Counts per tree, from this pest's thresholds" : "Counts per tree, thirds of the highest tree"}
              </div>
            </div>
          </MapControlPanel>
        );
      },
    };
  }, [kind, picked, bands, pestColor, diseaseColor, focus]);

  return <AvocadoTreeMap view={view} />;
}
