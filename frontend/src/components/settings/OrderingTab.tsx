/**
 * Settings → Ordering editor.
 *
 * Crop-scoped matrix that lets the GM decide which pests / diseases appear
 * first under each plant part on the mobile scouting screen. Rows are the
 * crop's pests (then diseases); columns are plant parts (Buds, Top, …). Each
 * cell is a rank — lower shows first; blank = unranked (keeps default order).
 *
 * Persists to the `priorities` (Filter Priority) child rows on each crop's
 * Pest Filter / Disease Filter via ordering_api. Mirrors the Thresholds tab.
 */

import { useEffect, useMemo, useState } from "react";
import { ListOrdered, Bug, Hexagon, Save, Loader2 } from "lucide-react";
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
import { listCrops } from "@/lib/thresholds-api";
import {
  getPriorities,
  savePriorities,
  type OrderingBundle,
  type OrderingRow,
} from "@/lib/ordering-api";

export function OrderingTab() {
  const [crops, setCrops] = useState<string[]>([]);
  const [crop, setCrop] = useState<string>("");
  const [bundle, setBundle] = useState<OrderingBundle | null>(null);
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
    getPriorities(crop)
      .then((b) => {
        if (!cancelled) setBundle(b);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || "Failed to load ordering");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [crop]);

  const patch = (
    group: "pests" | "diseases",
    i: number,
    section: string,
    value: number | null,
  ) => {
    if (!bundle) return;
    const rows = bundle[group].slice();
    const priorities = { ...rows[i].priorities };
    if (value === null || value <= 0) delete priorities[section];
    else priorities[section] = value;
    rows[i] = { ...rows[i], priorities };
    setBundle({ ...bundle, [group]: rows });
  };

  const onSave = async () => {
    if (!bundle || !crop) return;
    setSaving(true);
    setError(null);
    try {
      await savePriorities(crop, bundle);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const summary = useMemo(() => {
    if (!bundle) return { ranked: 0, sections: 0 };
    const count = (rows: OrderingRow[]) =>
      rows.reduce((s, r) => s + Object.keys(r.priorities).length, 0);
    return {
      ranked: count(bundle.pests) + count(bundle.diseases),
      sections: bundle.sections.length,
    };
  }, [bundle]);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-base">Observation Ordering</CardTitle>
          <CardDescription>
            Rank which pests / diseases show first under each plant part on the
            mobile scouting screen. Lower number = shown first; blank = default
            order.
          </CardDescription>
        </div>
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1 min-w-44">
            <Label htmlFor="ord-crop">Crop</Label>
            <Select value={crop} onValueChange={setCrop}>
              <SelectTrigger id="ord-crop" className="h-9">
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
        {error && <div className="text-xs text-destructive">{error}</div>}
        {savedAt && !error && !saving && (
          <div className="text-[0.7rem] text-muted-foreground">
            Saved at {savedAt}.
          </div>
        )}
        {loading && !bundle && (
          <div className="text-xs text-muted-foreground py-6 text-center">
            Loading ordering…
          </div>
        )}

        {bundle && (
          <>
            <div className="flex flex-wrap gap-2 text-[0.7rem] text-muted-foreground">
              <Badge variant="outline">{summary.ranked} ranked cells</Badge>
              <Badge variant="outline">{summary.sections} plant parts</Badge>
            </div>

            <Matrix
              title="Pests"
              icon={Bug}
              empty="No Pest Filter rows on this crop."
              sections={bundle.sections}
              rows={bundle.pests}
              onPatch={(i, section, v) => patch("pests", i, section, v)}
            />
            <Matrix
              title="Diseases"
              icon={Hexagon}
              empty="No Disease Filter rows on this crop."
              sections={bundle.sections}
              rows={bundle.diseases}
              onPatch={(i, section, v) => patch("diseases", i, section, v)}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Matrix({
  title,
  icon: Icon,
  empty,
  sections,
  rows,
  onPatch,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  empty: string;
  sections: string[];
  rows: OrderingRow[];
  onPatch: (i: number, section: string, value: number | null) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <ListOrdered className="h-3.5 w-3.5" />
        <Icon className="h-3.5 w-3.5" />
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="text-[0.72rem] text-muted-foreground italic px-2 py-3 border border-dashed rounded-md">
          {empty}
        </div>
      ) : (
        <div className="overflow-x-auto border rounded-md">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="text-left font-medium px-2 py-1.5 sticky left-0 bg-muted/40 z-10 min-w-32">
                  Observation
                </th>
                {sections.map((s) => (
                  <th key={s} className="font-medium px-2 py-1.5 text-center whitespace-nowrap">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.row} className="border-b last:border-0">
                  <td className="px-2 py-1 font-medium sticky left-0 bg-card z-10 whitespace-nowrap">
                    {r.name}
                  </td>
                  {sections.map((s) => (
                    <td key={s} className="px-1 py-1 text-center">
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        value={r.priorities[s] ?? ""}
                        placeholder="—"
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          onPatch(i, s, Number.isNaN(v) ? null : v);
                        }}
                        className="h-7 w-14 text-xs text-center tabular-nums mx-auto"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
