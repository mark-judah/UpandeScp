import { useCallback, useEffect, useState } from "react";
import type { SectionCell } from "@/lib/prevalence";
import {
  deletePin,
  getHouseClusters,
  listPins,
  savePin,
  type HouseClusters,
  type Patch,
  type ScoutingPin,
} from "@/lib/spread-api";
import { SectionGrid } from "./SectionGrid";
import { PatchesList } from "./PatchesList";
import { PinsPanel } from "./PinsPanel";
import { PinForm } from "./PinForm";

const ROW_WORDS = ["First third", "Middle third", "Last third"];
const COL_WORDS = ["front", "middle", "back"];

type Pending = { kind: "Section"; row: number; col: number } | { kind: "Patch"; patch: Patch };

export interface HouseSpreadProps {
  crop: string;
  greenhouse: string;
  kind: "pest" | "disease";
  observation: string;
  week?: string | null;
  sections: SectionCell[];
}

/** The greenhouse modal's "where it is" block (spread spec §6): the 3 × 3 grid
 *  with "Pin" per cell, the house's patches for this observation and week, and
 *  the house's pins with their sparklines. */
export function HouseSpread({ crop, greenhouse, kind, observation, week, sections }: HouseSpreadProps) {
  const [clusters, setClusters] = useState<HouseClusters | null>(null);
  const [pins, setPins] = useState<ScoutingPin[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setClusters(null);
    getHouseClusters({ crop, warehouse: greenhouse, observation, kind, week })
      .then((r) => live && setClusters(r))
      .catch(() => live && setClusters(null));
    return () => {
      live = false;
    };
  }, [crop, greenhouse, observation, kind, week]);

  const reloadPins = useCallback(() => {
    listPins(crop, greenhouse)
      .then(setPins)
      .catch(() => setPins([]));
  }, [crop, greenhouse]);
  useEffect(() => reloadPins(), [reloadPins]);
  useEffect(() => setPending(null), [greenhouse, observation, kind]);

  const defaultTitle = !pending
    ? ""
    : pending.kind === "Section"
      ? `${observation} · ${ROW_WORDS[pending.row]} · ${COL_WORDS[pending.col]}`
      : `${observation} · ${pending.patch.label}`;

  const save = async (title: string, shared: boolean) => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await savePin({
        crop,
        warehouse: greenhouse,
        kind: pending.kind,
        title,
        observation,
        obs_kind: kind,
        shared,
        source_week: clusters?.week ?? week ?? null,
        ...(pending.kind === "Section"
          ? { section_row: pending.row, section_col: pending.col }
          : { stations: pending.patch.stations }),
      });
      setPending(null);
      reloadPins();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the pin");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setError(null);
    try {
      await deletePin(name);
      reloadPins();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the pin");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <SectionGrid sections={sections} onPinSection={(row, col) => setPending({ kind: "Section", row, col })} />
      <PatchesList data={clusters} onPinPatch={(patch) => setPending({ kind: "Patch", patch })} />
      {pending ? (
        <PinForm key={defaultTitle} defaultTitle={defaultTitle} busy={busy} onSave={save} onCancel={() => setPending(null)} />
      ) : null}
      {error ? (
        <span role="alert" className="text-xs text-[var(--sd-data-red)]">
          {error}
        </span>
      ) : null}
      <div className="flex flex-col gap-1 border-t pt-2">
        <span className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">Pins</span>
        <PinsPanel pins={pins} onDelete={remove} />
      </div>
    </div>
  );
}
