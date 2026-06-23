/**
 * Settings → Thresholds editor.
 *
 * Crop-scoped editor for the severity thresholds that drive the
 * dashboard alerts. The GM picks a crop (Rose, …); the tab
 * loads every Pest Filter + Disease Filter row under it, plus the
 * per-stage children where they exist. Each row shows three Floats —
 * Low / Moderate / High — interpreted as ``% of zones in the
 * greenhouse with this (obs, stage)``. Per-stage rows override the
 * aggregate row for that stage; an aggregate row of all zeros means
 * "All stages" stays unconfigured and the dashboard skips alerting
 * for that obs.
 */

import { useEffect, useMemo, useState } from "react";
import { Bug, Hexagon, Save, Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  listCrops,
  getThresholds,
  saveThresholds,
  type ThresholdPestRow,
  type ThresholdDiseaseRow,
  type ThresholdStageRow,
  type ThresholdsBundle,
} from "@/lib/thresholds-api";

type FilterRow = ThresholdPestRow | ThresholdDiseaseRow;

function isPest(row: FilterRow): row is ThresholdPestRow {
  return (row as ThresholdPestRow).pest !== undefined;
}

export function ThresholdsTab() {
  const [crops, setCrops] = useState<string[]>([]);
  const [crop, setCrop] = useState<string>("");
  const [bundle, setBundle] = useState<ThresholdsBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string>("");

  useEffect(() => {
    listCrops()
      .then((r) => {
        setCrops(r);
        if (r.length && !crop) setCrop(r[0]);
      })
      .catch((e) => setError(e?.message || "Failed to load crops"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        if (cancelled) return;
        setBundle(b);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.message || "Failed to load thresholds");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [crop]);

  const patchPest = (
    i: number,
    patch: Partial<ThresholdPestRow>,
  ) => {
    if (!bundle) return;
    const pests = bundle.pests.slice();
    pests[i] = { ...pests[i], ...patch };
    setBundle({ ...bundle, pests });
  };
  const patchPestStage = (
    pi: number,
    si: number,
    patch: Partial<ThresholdStageRow>,
  ) => {
    if (!bundle) return;
    const pests = bundle.pests.slice();
    const stages = pests[pi].stages.slice();
    stages[si] = { ...stages[si], ...patch };
    pests[pi] = { ...pests[pi], stages };
    setBundle({ ...bundle, pests });
  };
  const patchDisease = (
    i: number,
    patch: Partial<ThresholdDiseaseRow>,
  ) => {
    if (!bundle) return;
    const diseases = bundle.diseases.slice();
    diseases[i] = { ...diseases[i], ...patch };
    setBundle({ ...bundle, diseases });
  };
  const patchDiseaseStage = (
    di: number,
    si: number,
    patch: Partial<ThresholdStageRow>,
  ) => {
    if (!bundle) return;
    const diseases = bundle.diseases.slice();
    const stages = diseases[di].stages.slice();
    stages[si] = { ...stages[si], ...patch };
    diseases[di] = { ...diseases[di], stages };
    setBundle({ ...bundle, diseases });
  };

  const onSave = async () => {
    if (!bundle || !crop) return;
    setSaving(true);
    setError(null);
    try {
      await saveThresholds(crop, bundle);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const summary = useMemo(() => {
    if (!bundle) return { pests: 0, diseases: 0, stages: 0 };
    const stages =
      bundle.pests.reduce((s, p) => s + p.stages.length, 0) +
      bundle.diseases.reduce((s, d) => s + d.stages.length, 0);
    return {
      pests: bundle.pests.length,
      diseases: bundle.diseases.length,
      stages,
    };
  }, [bundle]);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-base">Severity Thresholds</CardTitle>
          <CardDescription>
            % of zones in a greenhouse with the observation. Per-stage
            values override the aggregate. Zero = unconfigured (no
            alerts trigger).
          </CardDescription>
        </div>
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1 min-w-44">
            <Label htmlFor="th-crop">Crop</Label>
            <Select value={crop} onValueChange={setCrop}>
              <SelectTrigger id="th-crop" className="h-9">
                <SelectValue placeholder="Pick a crop" />
              </SelectTrigger>
              <SelectContent>
                {crops.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            onClick={onSave}
            disabled={saving || loading || !bundle}
            className="h-9 gap-2"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <div className="text-xs text-destructive">{error}</div>
        )}
        {savedAt && !error && !saving && (
          <div className="text-[0.7rem] text-muted-foreground">
            Saved at {savedAt}.
          </div>
        )}
        {loading && !bundle && (
          <div className="text-xs text-muted-foreground py-6 text-center">
            Loading thresholds…
          </div>
        )}

        {bundle && (
          <>
            <div className="flex flex-wrap gap-2 text-[0.7rem] text-muted-foreground">
              <Badge variant="outline">{summary.pests} pests</Badge>
              <Badge variant="outline">{summary.diseases} diseases</Badge>
              <Badge variant="outline">{summary.stages} stage rows</Badge>
            </div>

            <Section
              title="Pests"
              icon={Bug}
              empty="No Pest Filter rows on this crop."
            >
              {bundle.pests.map((p, i) => (
                <FilterEditor
                  key={p.row}
                  row={p}
                  onPatch={(patch) => patchPest(i, patch)}
                  onStagePatch={(si, patch) => patchPestStage(i, si, patch)}
                />
              ))}
            </Section>

            <Section
              title="Diseases"
              icon={Hexagon}
              empty="No Disease Filter rows on this crop."
            >
              {bundle.diseases.map((d, i) => (
                <FilterEditor
                  key={d.row}
                  row={d}
                  onPatch={(patch) => patchDisease(i, patch)}
                  onStagePatch={(si, patch) => patchDiseaseStage(i, si, patch)}
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

function FilterEditor({
  row,
  onPatch,
  onStagePatch,
}: {
  row: FilterRow;
  onPatch: (patch: Partial<FilterRow>) => void;
  onStagePatch: (i: number, patch: Partial<ThresholdStageRow>) => void;
}) {
  const name = isPest(row) ? row.pest : row.disease;
  return (
    <div className="border rounded-md p-2.5 bg-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{name}</span>
        <Select
          value={row.unit}
          onValueChange={(v) =>
            onPatch({ unit: v } as Partial<FilterRow>)
          }
        >
          <SelectTrigger className="h-7 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="Per Zone %">Per Zone %</SelectItem>
            <SelectItem value="Per Warehouse">Per Warehouse</SelectItem>
            <SelectItem value="Per Hectare">Per Hectare</SelectItem>
          </SelectContent>
        </Select>
        <ThresholdInputs
          values={{ low: row.low, moderate: row.moderate, high: row.high }}
          onChange={(patch) => onPatch(patch as Partial<FilterRow>)}
        />
      </div>
      {row.stages.length > 0 && (
        <div className="mt-2 pl-3 border-l-2 border-muted flex flex-col gap-1.5">
          <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
            Per-stage overrides
          </div>
          {row.stages.map((s, i) => (
            <div key={s.row} className="flex flex-wrap items-center gap-2">
              <span className="text-xs min-w-20 text-muted-foreground">
                {s.stage || "—"}
              </span>
              <ThresholdInputs
                values={{ low: s.low, moderate: s.moderate, high: s.high }}
                onChange={(patch) => onStagePatch(i, patch)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ThresholdInputs({
  values,
  onChange,
}: {
  values: { low: number; moderate: number; high: number };
  onChange: (patch: { low?: number; moderate?: number; high?: number }) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <ThInput
        label="Low"
        value={values.low}
        onChange={(v) => onChange({ low: v })}
      />
      <ThInput
        label="Mod"
        value={values.moderate}
        onChange={(v) => onChange({ moderate: v })}
      />
      <ThInput
        label="High"
        value={values.high}
        onChange={(v) => onChange({ high: v })}
      />
    </div>
  );
}

function ThInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <Input
        type="number"
        step="0.1"
        min="0"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="h-7 w-16 text-xs tabular-nums"
      />
      <span className="text-[0.6rem] text-muted-foreground">%</span>
    </div>
  );
}
