/**
 * Settings → Thresholds editor (thresholds spec §1, D1, D3).
 *
 * Per Pest/Disease Filter row of the route crop (`#/<crop>/settings`): a Measure
 * — Percentage (share of scouted stations carrying it, sections averaged) or
 * Count (average count per scouted station; only for a pest with a stage
 * scouts record as a number) — and the Low / Moderate / High bands, suffixed
 * in that measure's unit. Stage rows override the row for that stage; a
 * tick-box stage under a Count row is judged as a share, so its bands read "%".
 * Bands that are set must rise: a misordered row is flagged inline and Save
 * waits until it is fixed. All zeros = unconfigured (no alerts).
 * Pest stages show their role (Life stage / Form / Sign, set on the Stage
 * master) and this crop's weight for the stage in a Count (empty = the stage's
 * own weight).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bar, RowsSkeleton } from "@/components/Loading";
import { Bug, Hexagon, Save, Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  getThresholds,
  saveThresholds,
  type ThresholdPestRow,
  type ThresholdDiseaseRow,
  type ThresholdStageRow,
  type ThresholdsBundle,
} from "@/lib/thresholds-api";
import { bandsAscending, effectiveMeasure, unitFor, type Measure } from "@/lib/threshold-measure";
import { cn } from "@/lib/utils";
import { errorText } from "@/lib/errors";

type FilterRow = ThresholdPestRow | ThresholdDiseaseRow;

function isPest(row: FilterRow): row is ThresholdPestRow {
  return (row as ThresholdPestRow).pest !== undefined;
}

/** A weight scales a stage's count, so only a counted stage (a Life stage or Form
 *  scouts record as a number) under a pest row measured as a Count has one. */
export function weightApplies(row: FilterRow, measure: Measure, s: ThresholdStageRow): boolean {
  return isPest(row) && measure === "Count" && s.role !== "Sign" && s.reading_type === "Count";
}

/** A typed weight the server would refuse: not a finite number from 0 to WEIGHT_MAX. */
export function weightInvalid(text: string): boolean {
  const typed = text.trim();
  return typed !== "" && !(Number.isFinite(Number(typed)) && Number(typed) >= 0 && Number(typed) <= WEIGHT_MAX);
}

/** The row's or any stage's bands do not rise. */
export function rowInvalid(row: FilterRow): boolean {
  return (
    !bandsAscending(row.low, row.moderate, row.high) ||
    row.stages.some((s) => !bandsAscending(s.low, s.moderate, s.high))
  );
}

/** `crop` is the route crop (spec D7); the tab carries no picker of its own. */
export function ThresholdsTab({ crop }: { crop: string }) {
  const [bundle, setBundle] = useState<ThresholdsBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string>("");

  useEffect(() => {
    if (!crop) {
      setBundle(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getThresholds(crop)
      .then((b) => {
        if (!cancelled) setBundle(b);
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e, "Failed to load thresholds"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [crop]);

  const patchRow = (key: "pests" | "diseases", i: number, patch: Partial<FilterRow>) => {
    if (!bundle) return;
    if (key === "pests") {
      const pests = bundle.pests.slice();
      pests[i] = { ...pests[i], ...patch } as ThresholdPestRow;
      setBundle({ ...bundle, pests });
    } else {
      const diseases = bundle.diseases.slice();
      diseases[i] = { ...diseases[i], ...patch } as ThresholdDiseaseRow;
      setBundle({ ...bundle, diseases });
    }
  };
  const patchStage = (key: "pests" | "diseases", i: number, si: number, patch: Partial<ThresholdStageRow>) => {
    if (!bundle) return;
    const rows: FilterRow[] = key === "pests" ? bundle.pests : bundle.diseases;
    const stages = rows[i].stages.slice();
    stages[si] = { ...stages[si], ...patch };
    patchRow(key, i, { stages } as Partial<FilterRow>);
  };

  // Stage rows whose weight field holds a value the server would refuse.
  const [badWeights, setBadWeights] = useState<ReadonlySet<string>>(new Set());
  const markWeight = useCallback((id: string, bad: boolean) => {
    setBadWeights((prev) => {
      if (prev.has(id) === bad) return prev;
      const next = new Set(prev);
      if (bad) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const invalidRows = useMemo(
    () => (bundle ? [...bundle.pests, ...bundle.diseases].filter(rowInvalid).length : 0),
    [bundle],
  );

  const onSave = async () => {
    if (!bundle || !crop || invalidRows || badWeights.size) return;
    setSaving(true);
    setError(null);
    try {
      await saveThresholds(crop, bundle);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e: any) {
      setError(errorText(e, "Save failed"));
    } finally {
      setSaving(false);
    }
  };

  const summary = useMemo(() => {
    if (!bundle) return { pests: 0, diseases: 0, stages: 0 };
    const stages =
      bundle.pests.reduce((s, p) => s + p.stages.length, 0) +
      bundle.diseases.reduce((s, d) => s + d.stages.length, 0);
    return { pests: bundle.pests.length, diseases: bundle.diseases.length, stages };
  }, [bundle]);

  const station = bundle?.station || "zone";

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-base">Severity Thresholds{crop ? ` · ${crop}` : ""}</CardTitle>
          <CardDescription>
            Each row is measured as a Percentage (share of scouted stations carrying it) or a
            Count (average per scouted {station}). Moderate raises an Alarming notice, High a spray
            advisory. Stage values override the row. Bands must rise; zero = not set (no alerts).
          </CardDescription>
        </div>
        <div className="flex items-end gap-2">
          {invalidRows > 0 && (
            <span className="text-[0.7rem] text-destructive">
              {invalidRows} row{invalidRows !== 1 ? "s" : ""} need rising bands before saving.
            </span>
          )}
          {badWeights.size > 0 && (
            <span data-testid="weight-save-note" className="text-[0.7rem] text-destructive">
              Fix the weights outside 0 to {WEIGHT_MAX} before saving.
            </span>
          )}
          <Button
            type="button"
            onClick={onSave}
            disabled={saving || loading || !bundle || invalidRows > 0 || badWeights.size > 0}
            className="h-9 gap-2"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <div className="text-xs text-destructive whitespace-pre-line">{error}</div>}
        {!crop && (
          <div className="text-xs text-muted-foreground py-6 text-center">
            Open Settings from a crop's section to edit its thresholds.
          </div>
        )}
        {savedAt && !error && !saving && (
          <div className="text-[0.7rem] text-muted-foreground">Saved at {savedAt}.</div>
        )}
        {loading && !bundle && (
          // The Pests / Diseases sections are fixed; their editors are pending.
          <div className="flex flex-col gap-4" aria-busy="true">
            <div className="flex flex-wrap gap-2" aria-hidden>
              <Bar className="h-5 w-16 rounded-full" />
              <Bar className="h-5 w-20 rounded-full" />
              <Bar className="h-5 w-24 rounded-full" />
            </div>
            {([["Pests", Bug], ["Diseases", Hexagon]] as const).map(([title, Icon]) => (
              <div key={title} className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Icon className="h-3.5 w-3.5" />
                  {title}
                </div>
                <div className="rounded-md border">
                  <RowsSkeleton rows={4} />
                </div>
              </div>
            ))}
          </div>
        )}

        {bundle && (
          <>
            <div className="flex flex-wrap gap-2 text-[0.7rem] text-muted-foreground">
              <Badge variant="outline">{summary.pests} pests</Badge>
              <Badge variant="outline">{summary.diseases} diseases</Badge>
              <Badge variant="outline">{summary.stages} stage rows</Badge>
            </div>

            <Section title="Pests" icon={Bug} empty="No Pest Filter rows on this crop.">
              {bundle.pests.map((p, i) => (
                <FilterEditor
                  key={p.row}
                  row={p}
                  station={station}
                  onPatch={(patch) => patchRow("pests", i, patch)}
                  onStagePatch={(si, patch) => patchStage("pests", i, si, patch)}
                  onWeightValidity={markWeight}
                />
              ))}
            </Section>

            <Section title="Diseases" icon={Hexagon} empty="No Disease Filter rows on this crop.">
              {bundle.diseases.map((d, i) => (
                <FilterEditor
                  key={d.row}
                  row={d}
                  station={station}
                  onPatch={(patch) => patchRow("diseases", i, patch)}
                  onStagePatch={(si, patch) => patchStage("diseases", i, si, patch)}
                />
              ))}
            </Section>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Section({
  title,
  icon: Icon,
  empty,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  empty: string;
  children: React.ReactNode;
}) {
  const arr = Array.isArray(children) ? children : [children];
  const hasAny = arr.some(Boolean);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {title}
      </div>
      {hasAny ? (
        <div className="flex flex-col gap-2">{children}</div>
      ) : (
        <div className="text-[0.72rem] text-muted-foreground italic px-2 py-3 border border-dashed rounded-md">
          {empty}
        </div>
      )}
    </div>
  );
}

function MeasureToggle({
  name,
  value,
  countAllowed,
  onChange,
}: {
  name: string;
  value: Measure;
  countAllowed: boolean;
  onChange: (m: Measure) => void;
}) {
  return (
    <div role="radiogroup" aria-label={`Measure for ${name}`} className="inline-flex rounded-md border p-0.5">
      {(["Percentage", "Count"] as const).map((m) => {
        const disabled = m === "Count" && !countAllowed;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={value === m}
            disabled={disabled}
            onClick={() => onChange(m)}
            className={cn(
              "h-6 rounded px-2 text-[0.7rem] transition-colors",
              value === m ? "bg-primary text-primary-foreground" : "hover:bg-muted",
              disabled && "opacity-40 cursor-not-allowed hover:bg-transparent",
            )}
          >
            {m}
          </button>
        );
      })}
    </div>
  );
}

function BandError({ testId }: { testId: string }) {
  return (
    <div data-testid={testId} role="alert" className="mt-1 text-[0.7rem] text-destructive">
      Bands must rise: Low &lt; Moderate &lt; High (leave a band at 0 to skip it).
    </div>
  );
}

function FilterEditor({
  row,
  station,
  onPatch,
  onStagePatch,
  onWeightValidity,
}: {
  row: FilterRow;
  station: string;
  onPatch: (patch: Partial<FilterRow>) => void;
  onStagePatch: (i: number, patch: Partial<ThresholdStageRow>) => void;
  onWeightValidity?: (id: string, bad: boolean) => void;
}) {
  const name = isPest(row) ? row.pest : row.disease;
  const measure: Measure = row.measure === "Count" ? "Count" : "Percentage";
  return (
    <div className="border rounded-md p-2.5 bg-card" data-testid={`threshold-row-${row.row}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{name}</span>
        <MeasureToggle
          name={name}
          value={measure}
          countAllowed={row.count_allowed}
          onChange={(m) => onPatch({ measure: m } as Partial<FilterRow>)}
        />
        {!row.count_allowed && (
          <span className="text-[0.65rem] text-muted-foreground" data-testid={`count-hint-${row.row}`}>
            {isPest(row) ? "Count needs a stage scouts record as a number" : "Diseases are measured as a share"}
          </span>
        )}
        <ThresholdInputs
          unit={unitFor(measure, station)}
          values={{ low: row.low, moderate: row.moderate, high: row.high }}
          onChange={(patch) => onPatch(patch as Partial<FilterRow>)}
        />
      </div>
      {!bandsAscending(row.low, row.moderate, row.high) && <BandError testId={`band-error-${row.row}`} />}
      {row.stages.length > 0 && (
        <div className="mt-2 pl-3 flex flex-col gap-1.5">
          <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
            Per-stage overrides
          </div>
          {isPest(row) && (
            <div className="text-[0.65rem] text-muted-foreground">
              Signs (damage, webs, ragged margins) are reported beside the pest, never counted as it. Weight scales a
              stage's count in a Count; leave it empty for the stage's own weight.
            </div>
          )}
          {row.stages.map((s, i) => (
            <div key={s.row} className="flex flex-col">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs min-w-20 text-muted-foreground">{s.stage || "—"}</span>
                {isPest(row) && s.role && <StageRolePill role={s.role} testId={`stage-role-${s.row}`} />}
                <ThresholdInputs
                  unit={unitFor(effectiveMeasure(measure, s.reading_type), station)}
                  values={{ low: s.low, moderate: s.moderate, high: s.high }}
                  onChange={(patch) => onStagePatch(i, patch)}
                />
                {weightApplies(row, measure, s) && (
                  <WeightInput
                    id={s.row}
                    onValidity={onWeightValidity}
                    stage={s.stage}
                    value={s.weight ?? 0}
                    master={s.master_weight ?? 1}
                    onChange={(v) => onStagePatch(i, { weight: v })}
                  />
                )}
              </div>
              {!bandsAscending(s.low, s.moderate, s.high) && <BandError testId={`band-error-${s.row}`} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ThresholdInputs({
  unit,
  values,
  onChange,
}: {
  unit: string;
  values: { low: number; moderate: number; high: number };
  onChange: (patch: { low?: number; moderate?: number; high?: number }) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <ThInput label="Low" short="Low" unit={unit} value={values.low} onChange={(v) => onChange({ low: v })} />
      <ThInput label="Moderate" short="Mod" unit={unit} value={values.moderate} onChange={(v) => onChange({ moderate: v })} />
      <ThInput label="High" short="High" unit={unit} value={values.high} onChange={(v) => onChange({ high: v })} />
    </div>
  );
}

function ThInput({
  label,
  short,
  unit,
  value,
  onChange,
}: {
  label: string;
  short: string;
  unit: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">{short}</span>
      <Input
        type="number"
        step="0.1"
        min="0"
        aria-label={label}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="h-7 w-16 text-xs tabular-nums"
      />
      <span className="text-[0.6rem] text-muted-foreground">{unit}</span>
    </div>
  );
}

/** Largest stage weight the server accepts. */
const WEIGHT_MAX = 100;

const ROLE_TONE: Record<string, string> = {
  "Life stage": "var(--sd-data-green)",
  Form: "var(--sd-data-cyan)",
  Sign: "var(--sd-data-amber)",
};

/** A stage's role (stage & variety S1), set on the Stage master — a tinted
 *  pill, never a strip. */
function StageRolePill({ role, testId }: { role: string; testId: string }) {
  const tone = ROLE_TONE[role] ?? "var(--sd-muted)";
  return (
    <span
      data-testid={testId}
      title={role === "Sign" ? "A sign of the pest: reported beside it, never counted as it" : "Counts as the live pest"}
      className="inline-flex items-center rounded-full px-1.5 py-px text-[0.6rem] font-medium leading-none"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
    >
      {role}
    </span>
  );
}

/** This crop's weight for the stage in a Count (S5, S6). Empty = the stage's
 *  own weight, shown as the placeholder. A text field with its own draft, so
 *  "0." can be typed on the way to "0.5". */
function WeightInput({
  id,
  onValidity,
  stage,
  value,
  master,
  onChange,
}: {
  id: string;
  onValidity?: (id: string, bad: boolean) => void;
  stage: string;
  value: number;
  master: number;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(value > 0 ? String(value) : "");
  useEffect(() => {
    setText((t) => ((parseFloat(t) || 0) === value ? t : value > 0 ? String(value) : ""));
  }, [value]);
  const bad = weightInvalid(text);
  // Tell the tab, so Save waits; a field that goes away no longer blocks it.
  useEffect(() => {
    onValidity?.(id, bad);
    return () => onValidity?.(id, false);
  }, [id, bad, onValidity]);
  return (
    <div className="flex items-center gap-1">
      <span className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">Weight</span>
      <Input
        type="text"
        inputMode="decimal"
        aria-label={`Weight for ${stage}`}
        placeholder={String(master)}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // Sent as typed: the server refuses an out-of-range weight, never clamps it.
          onChange(parseFloat(e.target.value) || 0);
        }}
        aria-invalid={bad || undefined}
        className="h-7 w-14 text-xs tabular-nums"
      />
      {bad && (
        <span role="alert" className="text-[0.6rem] text-destructive" data-testid={`weight-error-${stage}`}>
          0 to {WEIGHT_MAX}
        </span>
      )}
    </div>
  );
}
