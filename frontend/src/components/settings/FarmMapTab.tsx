/**
 * Map Settings editor: global default lat/lon/zoom + per-farm
 * coordinates. The scouting maps fly-to a farm based on
 * these coords when the operator picks one.
 */

import { useMemo, useState } from "react";
import { Loader2, MapPin, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  saveFarmCoordinates,
  type FarmCoord,
  type MapSettings,
} from "@/lib/settings-api";
import { FrappeError } from "@/lib/frappe";

interface Props {
  initial: MapSettings;
  farms: string[];
  onSaved?: (saved: MapSettings) => void;
}

const PICKER_PLACEHOLDER = "__pick__";

export function FarmMapTab({ initial, farms, onSaved }: Props) {
  const [draft, setDraft] = useState<MapSettings>(initial);
  const [pickFarm, setPickFarm] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(initial),
    [draft, initial],
  );

  const setDefault = (patch: Partial<Pick<MapSettings, "lat" | "lon" | "default_zoom">>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setOk(false);
  };

  const upsertCoord = (farm: string, patch: Partial<FarmCoord>) => {
    setDraft((d) => ({
      ...d,
      farm_coordinates: d.farm_coordinates.map((r) =>
        r.farm === farm ? { ...r, ...patch } : r,
      ),
    }));
    setOk(false);
  };

  const removeCoord = (farm: string) => {
    setDraft((d) => ({
      ...d,
      farm_coordinates: d.farm_coordinates.filter((r) => r.farm !== farm),
    }));
    setOk(false);
  };

  const addCoord = () => {
    if (!pickFarm || pickFarm === PICKER_PLACEHOLDER) return;
    if (draft.farm_coordinates.some((c) => c.farm === pickFarm)) return;
    setDraft((d) => ({
      ...d,
      farm_coordinates: [
        ...d.farm_coordinates,
        { farm: pickFarm, lat: 0, lon: 0, default_zoom: 0 },
      ],
    }));
    setPickFarm("");
    setOk(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setOk(false);
    try {
      await saveFarmCoordinates(draft);
      setOk(true);
      onSaved?.(draft);
    } catch (e) {
      setError(e instanceof FrappeError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const availableFarms = farms.filter(
    (f) => !draft.farm_coordinates.some((c) => c.farm === f),
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            Global default
          </CardTitle>
          <CardDescription>
            Centre + zoom used when no farm-specific coordinates are
            configured (or no farm is selected on the map).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Num
            label="Default latitude"
            step="0.000001"
            value={draft.lat}
            onChange={(v) => setDefault({ lat: v })}
          />
          <Num
            label="Default longitude"
            step="0.000001"
            value={draft.lon}
            onChange={(v) => setDefault({ lon: v })}
          />
          <Num
            label="Default zoom"
            step="0.1"
            value={draft.default_zoom}
            onChange={(v) => setDefault({ default_zoom: v })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            Per-farm coordinates
          </CardTitle>
          <CardDescription>
            Drives the fly-to behaviour on the Traps / Observations / Rose
            scouting maps when a farm is picked.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <Label className="text-[0.7rem]">Add farm</Label>
              <Select
                value={pickFarm || PICKER_PLACEHOLDER}
                onValueChange={setPickFarm}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Pick a farm…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PICKER_PLACEHOLDER} disabled>
                    Pick a farm…
                  </SelectItem>
                  {availableFarms.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={addCoord}
              size="sm"
              className="h-9 gap-1"
              disabled={!pickFarm || pickFarm === PICKER_PLACEHOLDER}
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>
          {draft.farm_coordinates.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No per-farm coordinates set — every farm falls back to the
              global default above.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-1/4">Farm</TableHead>
                  <TableHead>Latitude</TableHead>
                  <TableHead>Longitude</TableHead>
                  <TableHead>Zoom</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {draft.farm_coordinates.map((c) => (
                  <TableRow key={c.farm}>
                    <TableCell className="font-medium">{c.farm}</TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.000001"
                        value={c.lat ?? 0}
                        onChange={(e) =>
                          upsertCoord(c.farm, {
                            lat: parseFloat(e.target.value) || 0,
                          })
                        }
                        className="h-8 tabular-nums"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.000001"
                        value={c.lon ?? 0}
                        onChange={(e) =>
                          upsertCoord(c.farm, {
                            lon: parseFloat(e.target.value) || 0,
                          })
                        }
                        className="h-8 tabular-nums"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.1"
                        value={c.default_zoom ?? 0}
                        onChange={(e) =>
                          upsertCoord(c.farm, {
                            default_zoom: parseFloat(e.target.value) || 0,
                          })
                        }
                        className="h-8 tabular-nums"
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => removeCoord(c.farm)}
                        title="Remove"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3 pt-1">
        {error && (
          <span className="text-xs text-destructive max-w-sm text-right">
            {error}
          </span>
        )}
        {ok && !dirty && (
          <span className="text-xs text-emerald-600 font-medium">Saved.</span>
        )}
        <Button onClick={save} disabled={!dirty || saving} size="lg">
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save coordinates
        </Button>
      </div>
    </div>
  );
}

function Num({
  label,
  step,
  value,
  onChange,
}: {
  label: string;
  step: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[0.7rem]">{label}</Label>
      <Input
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="h-9 tabular-nums"
      />
    </div>
  );
}
