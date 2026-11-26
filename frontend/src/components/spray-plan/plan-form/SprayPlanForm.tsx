/**
 * One spray plan's form, shared by the roses greenhouse plan and every block of the
 * field Application Floor Plan: Classification, Spray team | Kit | MOA on one row,
 * the tank mix (BOM) picker with "New tank mix", the chemicals with "Add chemical",
 * Available and Batch, the water, and the Scheduled Application.
 *
 * State and stock logic live in `useSprayPlanForm`; what only one page has (the roses
 * spray type, scope and stock matrix, the field block's findings) comes in as slots.
 * `compact` lays the form out as one column for the field planner's block panel; the
 * default is the roses page's two cards (Spray Details, Tank Mix).
 */
import { useState, type ReactNode } from "react";
import { FilePlus2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BomPicker, type BomOption } from "@/components/BomPicker";
import { DatePicker } from "@/components/DatePicker";
import { TimePicker } from "@/components/TimePicker";
import { FilterSelect } from "@/components/FilterSelect";
import { Bar, TableRowsSkeleton } from "@/components/Loading";
import { DEFAULT_METHOD, METHODS, planNeedsWater, type PlanField } from "@/lib/open-field";
import type { BomEligibility } from "@/lib/spray-compliance-api";
import { cn, mergeDateTime, splitDateTime } from "@/lib/utils";
import { AddChemicalDialog } from "./AddChemicalDialog";
import { ChemicalTable } from "./ChemicalTable";
import { NewTankMixDialog } from "./NewTankMixDialog";
import { NumInput } from "./plan-form-utils";
import { SprayTeamEditor, rowsOf, type TeamMemberRow } from "@/components/spray-plan/SprayTeamEditor";
import type { CreatorSprayTeam } from "@/lib/spray-plan-creator-api";
import type { PlanChemical, PlanFormState } from "./useSprayPlanForm";

export interface SprayPlanFormProps {
  state: PlanFormState;
  /** one column (the field planner's block panel) */
  compact?: boolean;
  /** spray teams for the team pill (picking one seeds the crew shown under the row);
   *  or `teamSlot` for the full roster editor with its own picker */
  teams?: CreatorSprayTeam[];
  /** crop for the team editor (which master teams the user may edit) */
  crop?: string;
  teamSlot?: ReactNode;
  kits: { kit: string; warehouse?: string | null }[];
  /** show the MOA (method of application) pill */
  showMethod?: boolean;
  boms: BomOption[];
  bomEligibility?: Record<string, BomEligibility>;
  bomDisabled?: boolean;
  /** a line under the tank-mix picker (e.g. "Pick targets first.") */
  bomHint?: ReactNode;
  /** after a tank mix is made in the dialog: refresh the list (the form then selects it) */
  onTankMixCreated?: (bomName: string) => Promise<void> | void;
  /** the targets the Add-chemical ranking judges by (defaults to the plan's) */
  targets?: string[];
  suggestedCodes?: string[];
  targetsSlot?: ReactNode;
  /** greenhouse: spray type, scope, varieties, beds, area (inside the Spray Details grid) */
  detailsSlot?: ReactNode;
  /** block: what was scouted there */
  topSlot?: ReactNode;
  /** block: a note beside the area and water (cost centre) */
  placeNote?: ReactNode;
  suggestionsSlot?: ReactNode;
  /** under the chemicals (roses: the stock matrix and spray check) */
  afterChemicals?: ReactNode;
  footer?: ReactNode;
  flagged?: Set<string>;
  renderInfo?: (c: PlanChemical) => ReactNode;
  /** block plans: the user tried to submit, so every missing required field is outlined */
  showErrors?: boolean;
}

export function SprayPlanForm(props: SprayPlanFormProps) {
  const { state, compact } = props;
  const [bomDialogOpen, setBomDialogOpen] = useState(false);
  const block = state.placeKind === "block";
  const mixItems = state.chemicals.map((c) => c.item_code);

  // Required fields (block plans). The marks come from the same problems list as the
  // block header and the submit gate, so they always agree. A missing field is outlined
  // once touched, or everywhere once the user tried to submit.
  const marks = !!compact && block;
  const [touched, setTouched] = useState<Set<PlanField>>(new Set());
  const touch = (fields: PlanField[]) =>
    setTouched((t) => (fields.every((f) => t.has(f)) ? t : new Set([...t, ...fields])));
  const errOf = (field: PlanField) =>
    marks && (props.showErrors || touched.has(field))
      ? state.fieldProblems.find((p) => p.field === field)
      : undefined;
  const req = marks ? <RequiredMark /> : null;
  const guard = (fields: PlanField[], node: ReactNode, className?: string) => {
    if (!marks || !node) return node;
    const e = fields.map(errOf).find(Boolean);
    return (
      <div
        className={cn(
          "rounded-lg transition-shadow",
          e && "-m-2 p-2 ring-2 ring-[var(--sd-data-red)]",
          className,
        )}
        data-invalid={e ? "true" : undefined}
        data-field={fields.join(" ")}
        onBlurCapture={() => touch(fields)}
      >
        {node}
        {e && (
          <p role="alert" className="mt-1 text-[0.7rem] text-[var(--sd-data-red)]" data-testid={`field-error-${e.field}`}>
            {e.message}
          </p>
        )}
      </div>
    );
  };

  const dialogs = (
    <>
      <AddChemicalDialog
        open={state.addOpen}
        onOpenChange={state.setAddOpen}
        notice={state.addNotice}
        onNoticeChange={state.setAddNotice}
        place={state.place}
        targets={props.targets ?? state.targets}
        mixItems={mixItems}
        when={state.scheduledAt}
        suggestedCodes={props.suggestedCodes}
        onPick={(it) => void state.addChemical(it)}
      />
      <NewTankMixDialog
        open={bomDialogOpen}
        onOpenChange={setBomDialogOpen}
        rateLimits={state.rateLimits}
        place={state.place}
        onCreated={async (name) => {
          await props.onTankMixCreated?.(name);
          state.setBom(name);
        }}
      />
    </>
  );

  const classification = (
    <div className={cn("flex flex-col gap-1", !compact && "col-span-2")}>
      <Label className={compact ? "text-xs" : undefined}>Classification{req}</Label>
      <div className="flex gap-2">
        {(["Curative", "Preventive"] as const).map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={state.classification === c}
            onClick={() => {
              state.setClassification(c);
              touch(["classification"]);
            }}
            className={cn(
              "rounded-full border px-4 py-1.5 text-xs transition-colors",
              state.classification === c
                ? "border-primary bg-primary text-primary-foreground"
                : "bg-muted hover:bg-muted/70",
            )}
          >
            {c}
          </button>
        ))}
      </div>
    </div>
  );

  const reason =
    state.classification === "Preventive" ? (
      <div className={cn("flex flex-col gap-1", !compact && "col-span-2")}>
        <Label className={cn("flex items-center justify-between", compact && "text-xs")}>
          <span>Preventive Reason</span>
          <span className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">
            required (min 20 chars)
          </span>
        </Label>
        <textarea
          value={state.reason}
          onChange={(e) => state.setReason(e.target.value)}
          placeholder="Why does this routine spray make sense without an observation trigger?"
          rows={compact ? 2 : 3}
          className="w-full rounded-md border bg-background px-3 py-2 text-xs"
        />
      </div>
    ) : null;

  const schedule = (
    <div className={cn("flex flex-col gap-1", !compact && "col-span-2")} data-testid="scheduled-application">
      <Label className={compact ? "text-xs" : undefined}>Scheduled Application{req}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <DatePicker
          variant="field"
          value={splitDateTime(state.scheduledAt).date}
          onChange={(d) => state.setScheduledAt((cur) => mergeDateTime(d, splitDateTime(cur).time))}
        />
        <TimePicker
          value={splitDateTime(state.scheduledAt).time}
          onChange={(t) => state.setScheduledAt((cur) => mergeDateTime(splitDateTime(cur).date, t))}
        />
      </div>
    </div>
  );

  const teamKitMoa = (
    <div
      className={cn("flex flex-wrap items-end gap-3", !compact && "col-span-2")}
      data-testid="team-kit-moa"
    >
      {props.teams && guard(["team"],
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Spray team{req}</Label>
          <FilterSelect
            label="Spray team"
            value={state.team}
            onChange={(v) => {
              // As the roses editor does: picking a team copies its members into
              // this plan's crew, which can then be changed for this plan alone.
              const t = props.teams?.find((x) => x.name === v);
              state.setTeam(v);
              state.setMembers(t ? rowsOf(t) : []);
            }}
            options={props.teams.map((t) => t.name)}
          />
        </div>,
      )}
      <div className="flex flex-col gap-1">
        <Label className="text-xs">Kit</Label>
        <FilterSelect
          label="Kit"
          value={state.kit}
          onChange={(v) => state.setKit(v)}
          options={props.kits.map((k) => k.kit)}
          format={(k) => {
            const wh = props.kits.find((x) => x.kit === k)?.warehouse;
            return wh ? `${k} · ${wh}` : k;
          }}
        />
      </div>
      {props.showMethod && guard(["method"],
        <div className="flex flex-col gap-1" title="Method of application">
          <Label className="text-xs">MOA{req}</Label>
          <FilterSelect
            label="Method of application"
            value={state.method || DEFAULT_METHOD}
            onChange={(v) => state.setMethod(v || DEFAULT_METHOD)}
            options={METHODS}
          />
        </div>,
      )}
    </div>
  );

  // The picked team's crew, names and roles, under the pill row (roses' roster).
  const crew =
    props.teams && state.team ? (
      <div className={cn(!compact && "col-span-2")} data-testid="plan-crew">
        <SprayTeamEditor
          hidePicker
          teams={props.teams}
          team={state.team}
          onTeamChange={state.setTeam}
          members={state.members as TeamMemberRow[]}
          onMembersChange={state.setMembers}
          crop={props.crop}
          onDate={(state.scheduledAt || "").slice(0, 10) || undefined}
        />
      </div>
    ) : null;

  const bomPicker = (
    <div className="flex items-end gap-2">
      <div className="flex-1 flex flex-col gap-1">
        <Label className={compact ? "text-xs" : undefined}>Tank Mix{req}</Label>
        <BomPicker
          boms={props.boms}
          value={state.bom}
          onValueChange={state.setBom}
          disabled={props.bomDisabled}
          eligibility={props.bomEligibility}
        />
        {props.bomHint}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9 gap-1 rounded-full"
        onClick={() => setBomDialogOpen(true)}
      >
        <FilePlus2 className="h-3.5 w-3.5" />
        New tank mix
      </Button>
    </div>
  );

  const addButton = (
    <Button variant="outline" size="sm" className="h-7 text-[0.7rem] rounded-full" onClick={() => state.setAddOpen(true)}>
      <Plus className="h-3 w-3" />
      Add chemical
    </Button>
  );

  const bomError = state.bomError && !state.bomLoading && (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
      {state.bomError}
    </div>
  );

  if (compact) {
    const needsWater = planNeedsWater(state.value);
    return (
      <div className="flex flex-col gap-4">
        {block && (
          <div className="flex flex-wrap items-end gap-3">
            {guard(["area"],
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Area (ha){req}</Label>
              <Input
                type="number" step="any" min={0} className="h-9 w-28 tabular-nums"
                aria-label="Area in hectares"
                value={state.area}
                placeholder={state.areaHa > 0 ? state.areaHa.toFixed(2) : "Enter area"}
                onChange={(e) => state.setArea(e.target.value)}
              />
            </div>)}
            {guard(["water"],
            <div className="flex flex-col gap-1">
              <Label className="text-xs">
                Water (L)
                {needsWater ? req : <span className="ml-1 text-muted-foreground">optional</span>}
              </Label>
              <Input
                type="number" step="any" min={0} className="h-9 w-32 tabular-nums"
                aria-label="Spray water in litres"
                value={state.water}
                placeholder="e.g. 2000"
                onChange={(e) => state.setWater(e.target.value)}
              />
            </div>)}
            {props.placeNote && <div className="pb-2 text-xs text-muted-foreground">{props.placeNote}</div>}
          </div>
        )}
        {props.topSlot}
        {guard(["classification"], classification)}
        {guard(["reason"], reason)}
        {guard(["targets"], props.targetsSlot)}
        {props.teamSlot}
        {teamKitMoa}
        {crew}
        {guard(["schedule"], schedule)}
        {guard(["bom"], bomPicker)}
        {bomError}
        {guard(["chemicals", "batch", "stock"],
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Chemicals{req}</Label>
            {addButton}
          </div>
          {state.bomLoading ? (
            <div className="rounded-lg border p-2" aria-busy="true" data-skeleton="bom">
              <Skeleton className="h-4 w-full" />
            </div>
          ) : state.chemicals.length ? (
            <div className="rounded-lg border overflow-x-auto">
              <ChemicalTable state={state} flagged={props.flagged} renderInfo={props.renderInfo} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {state.bom ? "This tank mix has no chemicals yet. Add one with the button above." : "Pick a tank mix or add a chemical."}
            </p>
          )}
          {block && state.stockShortRows.length > 0 && (
            <p
              className="text-xs text-[var(--sd-data-red)] tabular-nums"
              role="alert"
              data-testid="stock-short"
              title={state.stockShortRows
                .map((r) =>
                  r.source
                    ? `${r.name}: ${r.source} has ${r.avail} but needs ${r.need}`
                    : `${r.name}: no source warehouse picked (needs ${r.need})`,
                )
                .join("\n")}
            >
              {state.stockShortRows.length} chemical
              {state.stockShortRows.length === 1 ? " is" : "s are"} short on stock
              {state.stockShortRows.map((r) => (
                <span key={r.rowId} className="block text-[0.65rem]">
                  {r.source
                    ? `${r.name}: ${r.source} has ${r.avail.toFixed(2)} available but needs ${r.need.toFixed(2)}.`
                    : `${r.name}: pick a source warehouse.`}
                </span>
              ))}
            </p>
          )}
          {state.batchMissingRows.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-300" role="status">
              Pick a batch for {state.batchMissingRows.map((c) => c.item_name || c.item_code).join(", ")}.
            </p>
          )}
        </div>)}
        {props.afterChemicals}
        {props.suggestionsSlot}
        {props.footer}
        {dialogs}
      </div>
    );
  }

  return (
    <>
      <Card className="p-4">
        <CardHeader className="p-0 pb-2">
          <CardTitle className="text-sm">Spray Details</CardTitle>
        </CardHeader>
        <CardContent className="p-0 grid grid-cols-2 gap-3">
          {classification}
          {reason}
          {schedule}
          {props.detailsSlot}
          {props.teamSlot && <div className="col-span-2">{props.teamSlot}</div>}
          {teamKitMoa}
          {crew}
          {props.targetsSlot && <div className="col-span-2">{props.targetsSlot}</div>}
        </CardContent>
      </Card>

      <Card className="p-4">
        <CardHeader className="p-0 pb-2">
          <CardTitle className="text-sm">Tank Mix</CardTitle>
          <CardDescription>{props.boms.length} active tank mixes (bills of materials)</CardDescription>
        </CardHeader>
        <CardContent className="p-0 flex flex-col gap-3">
          {bomPicker}
          {props.suggestionsSlot}

          {state.bomLoading && (
            // The tank mix's own frame — water fields, the chemicals table
            // heading — with the values and rows pulsing.
            <div className="flex flex-col gap-3" aria-busy="true" data-skeleton="bom">
              <div className="grid grid-cols-3 gap-2">
                {["Water pH", "Hardness", "Water Volume (L)"].map((l) => (
                  <div key={l} className="flex flex-col gap-1">
                    <Label className="text-[0.65rem]">{l}</Label>
                    <Bar className="h-8" />
                  </div>
                ))}
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label>Chemicals (per 1000 L)</Label>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Chemical</TableHead>
                      <TableHead className="text-right">Rate / 1000 L</TableHead>
                      <TableHead>UoM</TableHead>
                      <TableHead className="text-right">Quantity</TableHead>
                      <TableHead className="text-right">Available</TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRowsSkeleton cols={6} rows={4} />
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {bomError}

          {state.bomDetails && !state.bomLoading && (
            <>
              <div className="grid grid-cols-3 gap-2">
                <NumInput label="Water pH" value={state.waterPh} onChange={state.setWaterPh} />
                <NumInput label="Hardness" value={state.waterHardness} onChange={state.setWaterHardness} />
                <NumInput label="Water Volume (L)" value={state.water} onChange={state.setWater} />
              </div>

              {/* Chemicals (per 1000 L) — the operator-editable rate is the source of
                  truth; the quantity (rate × water / 1000) is derived. */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label>Chemicals (per 1000 L)</Label>
                  {addButton}
                </div>
                {state.chemicals.length ? (
                  <ChemicalTable state={state} flagged={props.flagged} renderInfo={props.renderInfo} />
                ) : (
                  <div className="text-xs text-muted-foreground py-2">
                    This tank mix has no chemicals yet. Add one with the button above.
                  </div>
                )}
              </div>
              {props.afterChemicals}
            </>
          )}
          {props.footer}
        </CardContent>
      </Card>
      {dialogs}
    </>
  );
}

/** The mark on a required field's label (block plans). */
function RequiredMark() {
  return (
    <span className="ml-1.5 text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground" data-required>
      Required
    </span>
  );
}
