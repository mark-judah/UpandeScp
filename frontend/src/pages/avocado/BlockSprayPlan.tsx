import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createDraftSprayPlan,
  fetchCreatorBootstrap,
  type CreatorBootstrap,
} from "@/lib/spray-plan-creator-api";

import { errorText } from "@/lib/errors";
/** Litres of water per hectare — the same constant the rose planner uses to derive
 *  `custom_water_volume` from the area to spray. Kept identical on purpose: a block
 *  and a greenhouse are sprayed by the same crews with the same equipment, and a
 *  second constant would drift. */
const WATER_VOLUME_RATE = 1000;

export interface BlockChemRow {
  rowId: string;
  item_code: string;
  item_name?: string;
  stock_uom?: string;
  /** Operator-editable rate per 1000 L. `qty` is always derived from it. */
  rate: number;
}

/**
 * Prescribe a spray for one whole block.
 *
 * Roses are planned bed by bed: pick a greenhouse, pick a scope (whole house, a
 * variety, specific beds), and the area is summed from `Bed.bed__area`. Avocado and
 * coffee are planned **as a whole block** and the area comes straight off the
 * warehouse's `custom_area_ha` — Lokitela's 1,872 rows carry no area at all, so
 * summing units the rose way returns zero and every downstream quantity with it.
 *
 * Everything after the area is deliberately identical to roses, because it is the same
 * operation: water volume is area x 1000 L/ha, each chemical carries a rate per
 * 1000 L, and the quantity drawn from the store is `rate x waterVolume / 1000`. The
 * plan submits through the same `create_draft_spray_plan` as roses, with the block in
 * `custom_greenhouse` — a block is a Warehouse, so every downstream consumer
 * (approvals, transfers, the spray session, the mobile app) works unchanged.
 */
export function BlockSprayPlan({
  block,
  onDone,
}: {
  block: string;
  onDone?: (workOrder: string) => void;
}) {
  const [boot, setBoot] = useState<CreatorBootstrap | null>(null);
  const [team, setTeam] = useState("");
  const [kit, setKit] = useState("");
  const [rows, setRows] = useState<BlockChemRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    fetchCreatorBootstrap()
      .then(setBoot)
      .catch((e) => setError(errorText(e, "Could not load planning data.")));
  }, []);

  const blockInfo = useMemo(
    () => (boot?.blocks || []).find((b) => b.name === block) || null,
    [boot, block],
  );

  const areaHa = blockInfo?.area_ha || 0;
  const waterVolumeL = areaHa > 0 ? areaHa * WATER_VOLUME_RATE : 0;

  // Teams and kits are farm-scoped the same way the rose planner scopes them.
  const farm = blockInfo?.custom_farm;
  const teams = useMemo(
    () => (boot?.spray_teams || []).filter((t) => !farm || !t.custom_farm || t.custom_farm === farm),
    [boot, farm],
  );
  const kits = useMemo(
    () => (boot?.kits || []).filter((k) => !farm || !k.custom_farm || k.custom_farm === farm),
    [boot, farm],
  );

  const qtyFor = (rate: number) =>
    waterVolumeL > 0 ? (rate * waterVolumeL) / WATER_VOLUME_RATE : 0;

  const setRate = (rowId: string, rate: number) =>
    setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, rate } : r)));

  const addRow = () =>
    setRows((prev) => [
      ...prev,
      { rowId: `${Date.now()}-${prev.length}`, item_code: "", rate: 0 },
    ]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await createDraftSprayPlan({
        custom_greenhouse: block,
        custom_scope: "Whole Block",
        custom_spray_type: "Full",
        custom_kit: kit,
        custom_spray_team: team || null,
        custom_water_volume: waterVolumeL,
        custom_area: areaHa,
        chemicals: rows
          .filter((r2) => r2.item_code && r2.rate > 0)
          .map((r2) => ({
            item_code: r2.item_code,
            item_name: r2.item_name,
            uom: r2.stock_uom,
            application_rate: qtyFor(r2.rate),
          })),
      } as Parameters<typeof createDraftSprayPlan>[0]);
      const wo = r?.work_order;
      setDone(wo || "created");
      if (wo && onDone) onDone(wo);
    } catch (e: unknown) {
      setError(errorText(e, "Could not create the plan."));
    } finally {
      setBusy(false);
    }
  };

  if (error && !boot) {
    return <p className="px-1 py-2 text-xs text-destructive">{error}</p>;
  }
  if (!boot) {
    return (
      <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading planning data…
      </div>
    );
  }
  if (!blockInfo) {
    return (
      <p className="px-1 py-2 text-xs text-muted-foreground">
        {block} is not a block you can plan on — you are not rostered as a spray plan
        creator on its farm.
      </p>
    );
  }
  if (done) {
    return (
      <p className="px-1 py-2 text-xs text-emerald-600">
        Draft plan {done} created for {block}.
      </p>
    );
  }

  return (
    <div className="space-y-3 pt-1">
      <div className="rounded-md bg-muted/50 px-2 py-1.5 text-[0.7rem]">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Area</span>
          <span className="font-medium tabular-nums">{areaHa.toFixed(2)} ha</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Water volume</span>
          <span className="font-medium tabular-nums">
            {waterVolumeL.toFixed(0)} L
          </span>
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-[0.7rem]">Spray team</Label>
        <Select value={team} onValueChange={setTeam}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Pick a team" />
          </SelectTrigger>
          <SelectContent>
            {teams.map((t) => (
              <SelectItem key={t.name} value={t.name}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label className="text-[0.7rem]">Equipment (kit)</Label>
        <Select value={kit} onValueChange={setKit}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Pick a kit" />
          </SelectTrigger>
          <SelectContent>
            {kits.map((k) => (
              <SelectItem key={k.kit} value={k.kit}>
                {k.kit}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-[0.7rem]">Chemicals</Label>
          <button
            type="button"
            onClick={addRow}
            className="text-[0.7rem] text-primary hover:underline"
          >
            + add
          </button>
        </div>
        {rows.length === 0 && (
          <p className="text-[0.7rem] text-muted-foreground">
            Add a chemical and its rate per 1000 L.
          </p>
        )}
        {rows.map((r) => (
          <div key={r.rowId} className="flex items-center gap-1.5">
            <Input
              className="h-8 flex-1 text-xs"
              placeholder="Item code"
              value={r.item_code}
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((x) =>
                    x.rowId === r.rowId ? { ...x, item_code: e.target.value } : x,
                  ),
                )
              }
            />
            <Input
              className="h-8 w-20 text-xs"
              type="number"
              placeholder="rate"
              value={r.rate || ""}
              onChange={(e) => setRate(r.rowId, parseFloat(e.target.value) || 0)}
            />
            <span className="w-16 shrink-0 text-right text-[0.7rem] tabular-nums text-muted-foreground">
              {qtyFor(r.rate).toFixed(2)}
            </span>
          </div>
        ))}
        {rows.length > 0 && (
          <p className="text-[0.7rem] text-muted-foreground">
            Right-hand column is the quantity drawn from the store: rate x{" "}
            {waterVolumeL.toFixed(0)} L / 1000.
          </p>
        )}
      </div>

      {error && <p className="text-[0.7rem] text-destructive">{error}</p>}

      <Button
        size="sm"
        className="w-full"
        onClick={submit}
        disabled={busy || areaHa <= 0 || !rows.some((r) => r.item_code && r.rate > 0)}
      >
        {busy ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
        Create draft plan
      </Button>
      {areaHa <= 0 && (
        <p className="text-center text-[0.7rem] text-muted-foreground">
          This block has no area recorded, so no quantities can be derived.
        </p>
      )}
    </div>
  );
}
