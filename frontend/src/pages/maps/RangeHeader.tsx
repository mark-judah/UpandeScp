/**
 * Range header for map pages — Crop / Farm / Greenhouse cascade plus a
 * From/To date range that is hard-capped to one week (7 inclusive days).
 *
 * The legacy single-day pages picked one date because multi-day overlap turns
 * the map into spaghetti at large ranges. A week is the sweet spot: it lets you
 * see repeated/overlapping coverage across a few days without the clutter, and
 * the data loads off the per-ISO-week Redis cache, so one or two weeks is cheap.
 */

import { useEffect, useState, type ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { WeekPicker } from "@/components/WeekPicker";
import {
  fetchCrops,
  fetchFarmsAndWarehouses,
  DEFAULT_CROP,
} from "@/lib/scouting-api";

export const ALL = "__all__";

/** Inclusive max span: 7 calendar days (from + 6). */
export const MAX_RANGE_DAYS = 6;

export interface RangeFilterValue {
  crop: string;
  farm: string;
  greenhouse: string;
  from: string;
  to: string;
}

const MS_DAY = 86_400_000;
const toDate = (s: string) => new Date(`${s}T00:00:00`);
const fmt = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const addDays = (s: string, n: number) => {
  const d = toDate(s);
  d.setDate(d.getDate() + n);
  return fmt(d);
};
const spanDays = (from: string, to: string) =>
  Math.round((toDate(to).getTime() - toDate(from).getTime()) / MS_DAY);

/** Clamp a (from,to) edit to a forward, <=1-week window. The field the user
 *  just changed stays put; the other end is pulled in to satisfy the cap. */
export function clampWeek(
  from: string,
  to: string,
  changed: "from" | "to",
): { from: string; to: string } {
  if (!from || !to) return { from: from || to, to: to || from };
  if (changed === "from") {
    if (to < from) return { from, to: from };
    if (spanDays(from, to) > MAX_RANGE_DAYS)
      return { from, to: addDays(from, MAX_RANGE_DAYS) };
    return { from, to };
  }
  if (from > to) return { from: to, to };
  if (spanDays(from, to) > MAX_RANGE_DAYS)
    return { from: addDays(to, -MAX_RANGE_DAYS), to };
  return { from, to };
}

export interface RangeHeaderProps {
  title: string;
  subtitle: string;
  value: RangeFilterValue;
  onChange: (next: RangeFilterValue) => void;
  showGreenhouse?: boolean;
  showCrop?: boolean;
  rightSlot?: ReactNode;
}

export function RangeHeader({
  title,
  subtitle,
  value,
  onChange,
  showGreenhouse = true,
  showCrop = true,
  rightSlot,
}: RangeHeaderProps) {
  const [crops, setCrops] = useState<
    Array<{ name: string; crop_name: string; farms?: string[] }>
  >([{ name: DEFAULT_CROP, crop_name: DEFAULT_CROP, farms: [] }]);
  const [farms, setFarms] = useState<Record<string, string[]>>({});

  useEffect(() => {
    fetchCrops().then((r) => {
      if (!r.length) return;
      const hasDefault = r.some((c) => c.crop_name === DEFAULT_CROP);
      setCrops(
        hasDefault
          ? r
          : [{ name: DEFAULT_CROP, crop_name: DEFAULT_CROP, farms: [] }, ...r],
      );
    });
    fetchFarmsAndWarehouses().then(setFarms);
  }, []);

  const farmList = (() => {
    const cropAllow =
      crops.find((c) => c.crop_name === value.crop)?.farms || [];
    const all = Object.keys(farms);
    if (!cropAllow.length) return all;
    const allowSet = new Set(cropAllow);
    return all.filter((f) => allowSet.has(f));
  })();

  const greenhouseList =
    value.farm === ALL
      ? Array.from(new Set(farmList.flatMap((f) => farms[f] || []))).sort()
      : (farms[value.farm] || []).slice().sort();

  return (
    <header className="sticky top-0 z-20 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-6" />
          <div>
            <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight">
              {title}
            </h1>
            <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
              {subtitle}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          {showCrop && (
            <div className="flex flex-col gap-1 min-w-32">
              <Label>Crop</Label>
              <Select
                value={value.crop}
                onValueChange={(v) =>
                  onChange({ ...value, crop: v, farm: ALL, greenhouse: ALL })
                }
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {crops.map((c) => (
                    <SelectItem key={c.crop_name} value={c.crop_name}>
                      {c.crop_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex flex-col gap-1 min-w-32">
            <Label>Farm</Label>
            <Select
              value={value.farm}
              onValueChange={(v) =>
                onChange({ ...value, farm: v, greenhouse: ALL })
              }
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All Farms</SelectItem>
                {farmList.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {showGreenhouse && (
            <div className="flex flex-col gap-1 min-w-40">
              <Label>Greenhouse</Label>
              <Select
                value={value.greenhouse}
                onValueChange={(v) => onChange({ ...value, greenhouse: v })}
                disabled={!greenhouseList.length}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All Greenhouses</SelectItem>
                  {greenhouseList.map((g) => (
                    <SelectItem key={g} value={g}>
                      {g}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <Label>Week</Label>
            <WeekPicker
              value={{ from: value.from, to: value.to }}
              onChange={(r) => onChange({ ...value, from: r.from, to: r.to })}
            />
          </div>

          {rightSlot}
        </div>
      </div>
    </header>
  );
}
