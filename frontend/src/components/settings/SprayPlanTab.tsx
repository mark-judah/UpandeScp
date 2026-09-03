/**
 * Spray Plan Settings (Single) editor — rotation windows, weather
 * thresholds, gating flags, allowed farms, exclude keywords.
 */

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Loader2,
  Plus,
  Save,
  Trash2,
  Wind,
  CloudRain,
  Thermometer,
  RotateCw,
  Building2,
  Ban,
} from "lucide-react";
import { TimezoneCard } from "@/components/settings/TimezoneCard";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  saveSprayPlanSettings,
  type SprayPlanSettings,
} from "@/lib/settings-api";

import { errorText } from "@/lib/errors";
interface Props {
  initial: SprayPlanSettings;
  farms: string[];
  onSaved?: (saved: SprayPlanSettings) => void;
}

const ALL_FARM_PICKER = "__pick__";

export function SprayPlanTab({ initial, farms, onSaved }: Props) {
  const [draft, setDraft] = useState<SprayPlanSettings>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [pickFarm, setPickFarm] = useState<string>("");
  const [keyword, setKeyword] = useState<string>("");

  const set = <K extends keyof SprayPlanSettings>(
    key: K,
    value: SprayPlanSettings[K],
  ) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setOk(false);
  };

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(initial),
    [draft, initial],
  );

  const addFarm = () => {
    if (!pickFarm || pickFarm === ALL_FARM_PICKER) return;
    if (draft.allowed_farms.some((f) => f.farm === pickFarm)) return;
    set("allowed_farms", [...draft.allowed_farms, { farm: pickFarm }]);
    setPickFarm("");
  };
  const removeFarm = (farm: string) =>
    set(
      "allowed_farms",
      draft.allowed_farms.filter((f) => f.farm !== farm),
    );

  const addKeyword = () => {
    const k = keyword.trim();
    if (!k) return;
    if (draft.exclude_keywords.some((x) => x.keyword === k)) return;
    set("exclude_keywords", [...draft.exclude_keywords, { keyword: k }]);
    setKeyword("");
  };
  const removeKeyword = (kw: string) =>
    set(
      "exclude_keywords",
      draft.exclude_keywords.filter((x) => x.keyword !== kw),
    );

  const save = async () => {
    setSaving(true);
    setError(null);
    setOk(false);
    try {
      await saveSprayPlanSettings(draft);
      setOk(true);
      onSaved?.(draft);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const availableFarms = farms.filter(
    (f) => !draft.allowed_farms.some((af) => af.farm === f),
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <RotateCw className="h-4 w-4 text-muted-foreground" />
            Resistance rotation windows
          </CardTitle>
          <CardDescription>
            Days within which the same IRAC / FRAC code is flagged as a
            rotation risk on the approval review.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <Num
            label="IRAC (days)"
            value={draft.irac_rotation_window_days}
            onChange={(v) => set("irac_rotation_window_days", v)}
          />
          <Num
            label="FRAC (days)"
            value={draft.frac_rotation_window_days}
            onChange={(v) => set("frac_rotation_window_days", v)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Wind className="h-4 w-4 text-muted-foreground" />
            Weather spray-friendliness thresholds
          </CardTitle>
          <CardDescription>
            Drives the green / red banner on the spray plan creator weather
            snapshot.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-xs">
          <div className="col-span-2 inline-flex items-center gap-2 text-[0.7rem] uppercase tracking-wide text-muted-foreground font-semibold">
            <Wind className="h-3 w-3" /> Wind (km/h)
          </div>
          <Num
            label="Green ≤"
            value={draft.weather_wind_green_max_kmh}
            onChange={(v) => set("weather_wind_green_max_kmh", v)}
          />
          <Num
            label="Red ≥"
            value={draft.weather_wind_red_min_kmh}
            onChange={(v) => set("weather_wind_red_min_kmh", v)}
          />

          <div className="col-span-2 mt-2 inline-flex items-center gap-2 text-[0.7rem] uppercase tracking-wide text-muted-foreground font-semibold">
            <CloudRain className="h-3 w-3" /> Rain probability (%)
          </div>
          <Num
            label="Green ≤"
            value={draft.weather_rain_green_max_pct}
            onChange={(v) => set("weather_rain_green_max_pct", v)}
          />
          <Num
            label="Red ≥"
            value={draft.weather_rain_red_min_pct}
            onChange={(v) => set("weather_rain_red_min_pct", v)}
          />

          <div className="col-span-2 mt-2 inline-flex items-center gap-2 text-[0.7rem] uppercase tracking-wide text-muted-foreground font-semibold">
            <Thermometer className="h-3 w-3" /> Temperature (°C)
          </div>
          <Num
            label="Green min ≥"
            value={draft.weather_temp_green_min_c}
            onChange={(v) => set("weather_temp_green_min_c", v)}
          />
          <Num
            label="Green max ≤"
            value={draft.weather_temp_green_max_c}
            onChange={(v) => set("weather_temp_green_max_c", v)}
          />
          <Num
            label="Red high ≥"
            value={draft.weather_temp_red_max_c}
            onChange={(v) => set("weather_temp_red_max_c", v)}
          />
          <Num
            label="Red low ≤"
            value={draft.weather_temp_red_min_c}
            onChange={(v) => set("weather_temp_red_min_c", v)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            Allowed farms
          </CardTitle>
          <CardDescription>
            Restricts which farms can be picked in the spray plan creator.
            Empty list means every farm is allowed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <Label className="text-[0.7rem]">Add farm</Label>
              <Select value={pickFarm || ALL_FARM_PICKER} onValueChange={setPickFarm}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Pick a farm…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_FARM_PICKER} disabled>
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
              onClick={addFarm}
              size="sm"
              className="h-9 gap-1"
              disabled={!pickFarm || pickFarm === ALL_FARM_PICKER}
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>
          {draft.allowed_farms.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No farms restricted — every farm is allowed.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {draft.allowed_farms.map((f) => (
                <li
                  key={f.farm}
                  className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 text-primary px-2.5 py-1 text-xs font-medium"
                >
                  {f.farm}
                  <button
                    type="button"
                    onClick={() => removeFarm(f.farm)}
                    className="text-primary/70 hover:text-destructive transition-colors"
                    title="Remove"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Ban className="h-4 w-4 text-muted-foreground" />
            Exclude keywords
          </CardTitle>
          <CardDescription>
            Greenhouses whose name contains any of these (case-insensitive)
            are hidden from the picker. Useful for CSU / IPM / phase rooms.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <Label className="text-[0.7rem]">Add keyword</Label>
              <Input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="e.g. CSU, IPM, Phase"
                className="h-9"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addKeyword();
                  }
                }}
              />
            </div>
            <Button
              onClick={addKeyword}
              size="sm"
              className="h-9 gap-1"
              disabled={!keyword.trim()}
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>
          {draft.exclude_keywords.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No keywords — every matching greenhouse is shown.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {draft.exclude_keywords.map((k) => (
                <li
                  key={k.keyword}
                  className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 text-destructive px-2.5 py-1 text-xs font-medium"
                >
                  {k.keyword}
                  <button
                    type="button"
                    onClick={() => removeKeyword(k.keyword)}
                    className="text-destructive/70 hover:text-destructive transition-colors"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Submission gating</CardTitle>
          <CardDescription>
            Who may submit a plan, and what they must prove to do it. The
            chemical expense and difference accounts moved to the Accounts tab.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
            <Checkbox
              id="bypass_owner_check"
              checked={!!draft.bypass_owner_check}
              onCheckedChange={(v) => set("bypass_owner_check", v ? 1 : 0)}
            />
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="bypass_owner_check"
                className="text-xs font-semibold cursor-pointer"
              >
                Bypass owner check on Submit for Approval
              </Label>
              <p className="text-[0.65rem] text-muted-foreground leading-snug">
                When on, any Spray Plan Creator can submit any plan they can
                see. Off restricts submit to the plan's owner.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
            <Checkbox
              id="allow_submit_without_biometric"
              checked={!!draft.allow_submit_without_biometric}
              onCheckedChange={(v) =>
                set("allow_submit_without_biometric", v ? 1 : 0)
              }
            />
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="allow_submit_without_biometric"
                className="text-xs font-semibold cursor-pointer"
              >
                Allow submit without biometric (device-down fallback)
              </Label>
              <p className="text-[0.65rem] text-muted-foreground leading-snug">
                When on, the Spray Plan Transfers page also offers a “Submit
                without biometric” action. Use only when the biometric device
                is unavailable — the submitting user is recorded. Leave off in
                normal operation.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-lg border bg-card p-3 md:col-span-2">
            <Checkbox
              id="csu_scan_verification"
              checked={draft.csu_scan_verification === "tick"}
              onCheckedChange={(v) =>
                set("csu_scan_verification", v ? "tick" : "labels")
              }
            />
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="csu_scan_verification"
                className="text-xs font-semibold cursor-pointer"
              >
                Allow tick-to-confirm instead of scanning CSU labels
              </Label>
              <p className="text-[0.65rem] text-muted-foreground leading-snug">
                Off (the default) requires the sprayer to scan each chemical's
                printed QR label as it leaves the chemical store. On lets them
                tick to confirm instead — for farms where label printing isn't
                available.
              </p>
              {draft.csu_scan_verification === "tick" && (
                <p className="mt-1 inline-flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[0.65rem] font-medium leading-snug text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
                  <AlertTriangle className="h-3 w-3 shrink-0 mt-px" />
                  <span>
                    Sprayers can confirm chemicals without scanning, so there is
                    no per-chemical check that what left the store matches the
                    plan. Turn this back off once labels are printing again.
                  </span>
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Auto-cancel dormant plans</CardTitle>
          <CardDescription>
            Automatically stop plans submitted for approval but left unapproved.
            Stopping is reversible (un-stop in Desk).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
            <Checkbox
              id="auto_cancel_enabled"
              checked={!!draft.auto_cancel_enabled}
              onCheckedChange={(v) => set("auto_cancel_enabled", v ? 1 : 0)}
            />
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="auto_cancel_enabled"
                className="text-xs font-semibold cursor-pointer"
              >
                Enable the daily auto-cancel job
              </Label>
              <p className="text-[0.65rem] text-muted-foreground leading-snug">
                When off, no plan is ever auto-stopped.
                {draft.auto_cancel_activated_on
                  ? ` Going-forward cutoff: ${draft.auto_cancel_activated_on.slice(0, 16)}.`
                  : ""}
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
            <Checkbox
              id="auto_cancel_apply_to_backlog"
              checked={!!draft.auto_cancel_apply_to_backlog}
              disabled={!draft.auto_cancel_enabled}
              onCheckedChange={(v) =>
                set("auto_cancel_apply_to_backlog", v ? 1 : 0)
              }
            />
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="auto_cancel_apply_to_backlog"
                className="text-xs font-semibold cursor-pointer"
              >
                Apply to historical backlog
              </Label>
              <p className="text-[0.65rem] text-muted-foreground leading-snug">
                Off = only plans created after enabling are eligible (going
                forward). On = every existing dormant plan is stopped too.
              </p>
            </div>
          </div>

          <div>
            <Label className="text-[0.7rem]">Dormant window (days)</Label>
            <Input
              type="number"
              min={1}
              value={draft.auto_cancel_dormant_days}
              disabled={!draft.auto_cancel_enabled}
              onChange={(e) =>
                set("auto_cancel_dormant_days", Number(e.target.value) || 0)
              }
              className="h-9 w-32"
            />
            <p className="mt-1 text-[0.65rem] text-muted-foreground leading-snug">
              Days since creation after which an unapproved plan is stopped.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* First on the page: the cutoff, the reminders and the reports below all
        * depend on which clock the site is running. */}
      <TimezoneCard />

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Postponement &amp; spray cutoff</CardTitle>
          <CardDescription>
            When a spray stops being actionable on its own date, and how far a
            supervisor may push it.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <Label className="text-[0.7rem]">Daily cutoff time</Label>
            <Input
              type="time"
              value={(draft.spray_cutoff_time || "10:00:00").slice(0, 5)}
              onChange={(e) =>
                set("spray_cutoff_time", `${e.target.value}:00`)
              }
              className="h-9 w-32"
            />
            <p className="mt-1 text-[0.65rem] leading-snug text-muted-foreground">
              Measured on the plan&apos;s <strong>own</strong> spray date. After it,
              no postponement and no starting the spray — which is also what stops
              yesterday&apos;s plan being sprayed today.
            </p>
          </div>
          <div>
            <Label className="text-[0.7rem]">Furthest push (days)</Label>
            <Input
              type="number"
              min={1}
              max={60}
              value={draft.postponement_max_days ?? 7}
              onChange={(e) =>
                set("postponement_max_days", Number(e.target.value) || 0)
              }
              className="h-9 w-32"
            />
            <p className="mt-1 text-[0.65rem] leading-snug text-muted-foreground">
              A plan deferred further than this has been abandoned rather than moved;
              stop it instead.
            </p>
          </div>
          <div>
            <Label className="text-[0.7rem]">Grace after cutoff (minutes)</Label>
            <Input
              type="number"
              min={0}
              max={720}
              value={draft.postponement_grace_minutes ?? 0}
              onChange={(e) =>
                set("postponement_grace_minutes", Number(e.target.value) || 0)
              }
              className="h-9 w-32"
            />
            <p className="mt-1 text-[0.65rem] leading-snug text-muted-foreground">
              For the supervisor standing in the field at 10:01. Extends declaring
              only — starting a late spray stays refused.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Chemical allocation</CardTitle>
          <CardDescription>
            How a purchase received into the general store is split back to the
            farms that requested it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
            <Checkbox
              id="allocation_balancing_enabled"
              checked={!!draft.allocation_balancing_enabled}
              onCheckedChange={(v) =>
                set("allocation_balancing_enabled", v ? 1 : 0)
              }
            />
            <div className="flex flex-col gap-2">
              <Label
                htmlFor="allocation_balancing_enabled"
                className="text-xs font-semibold cursor-pointer"
              >
                Balance allocations and carry credits forward
              </Label>
              <p className="text-[0.65rem] text-muted-foreground leading-snug">
                <strong>Off (default):</strong> each farm gets its share rounded
                down to an amount the store can measure, and whatever will not
                divide evenly stays in the general store. Easy to check by hand.
              </p>
              <p className="text-[0.65rem] text-muted-foreground leading-snug">
                <strong>On:</strong> the leftover measurable amounts go to the
                farms with the largest fractions, and each farm's shortfall is
                remembered and added to its next request. Fairer to small farms
                across several cycles, but the arithmetic is no longer obvious
                from one allocation.
              </p>
              <p className="text-[0.65rem] text-muted-foreground leading-snug">
                Switching this off leaves any credits already earned untouched —
                they are simply not applied until it is switched back on.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Farm-to-farm chemical loaning</CardTitle>
          <CardDescription>
            Let a depleted farm request a chemical from a sibling farm; the source
            farm's creator approves and the stock transfers across.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-start gap-3 rounded-lg border bg-card p-3 md:col-span-2">
            <Checkbox
              id="loaning_enabled"
              checked={!!draft.loaning_enabled}
              onCheckedChange={(v) => set("loaning_enabled", v ? 1 : 0)}
            />
            <div className="flex flex-col gap-1">
              <Label htmlFor="loaning_enabled" className="text-xs font-semibold cursor-pointer">
                Enable chemical loaning
              </Label>
              <p className="text-[0.65rem] text-muted-foreground leading-snug">
                When off, the Chemical Loaning page is inert and no cross-farm
                availability is shown.
              </p>
            </div>
          </div>
          <div>
            <Label className="text-[0.7rem]">Depletion threshold (%)</Label>
            <Input
              type="number"
              min={1}
              max={100}
              value={draft.loaning_depletion_pct}
              disabled={!draft.loaning_enabled}
              onChange={(e) => set("loaning_depletion_pct", Number(e.target.value) || 0)}
              className="h-9 w-32"
            />
            <p className="mt-1 text-[0.65rem] text-muted-foreground leading-snug">
              Cross-farm availability unlocks when on-hand drops below this % of
              the captured baseline.
            </p>
          </div>
          <div>
            <Label className="text-[0.7rem]">Request timeout (hours)</Label>
            <Input
              type="number"
              min={1}
              value={draft.loaning_timeout_hours}
              disabled={!draft.loaning_enabled}
              onChange={(e) => set("loaning_timeout_hours", Number(e.target.value) || 0)}
              className="h-9 w-32"
            />
            <p className="mt-1 text-[0.65rem] text-muted-foreground leading-snug">
              Pending requests auto-expire after this many hours.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Daily progress email</CardTitle>
          <CardDescription>
            A black-and-white "Chemical Planning Progress Update" digest of
            today's scheduled plans and their progress, per farm — to the GM,
            approvers and creators (their farms only).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
            <Checkbox
              id="progress_email_enabled"
              checked={!!draft.progress_email_enabled}
              onCheckedChange={(v) => set("progress_email_enabled", v ? 1 : 0)}
            />
            <div className="flex flex-col gap-1">
              <Label htmlFor="progress_email_enabled" className="text-xs font-semibold cursor-pointer">
                Send the daily progress email
              </Label>
              <p className="text-[0.65rem] text-muted-foreground leading-snug">
                Sent once a day at the hour below. Farms with no plans that day
                are skipped.
              </p>
            </div>
          </div>
          <div>
            <Label className="text-[0.7rem]">Send hour (0–23, EAT)</Label>
            <Input
              type="number"
              min={0}
              max={23}
              value={draft.progress_email_hour}
              disabled={!draft.progress_email_enabled}
              onChange={(e) => set("progress_email_hour", Number(e.target.value) || 0)}
              className="h-9 w-32"
            />
            <p className="mt-1 text-[0.65rem] text-muted-foreground leading-snug">
              18 = 6pm / end of day. The job checks hourly and sends at this hour.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="lg:col-span-2 flex items-center justify-end gap-3 pt-1">
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
          Save settings
        </Button>
      </div>
    </div>
  );
}

function Num({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[0.7rem]">{label}</Label>
      <Input
        type="number"
        step="any"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="h-9 tabular-nums"
      />
    </div>
  );
}
