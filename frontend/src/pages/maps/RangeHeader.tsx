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
import { PageHeader } from "@/components/PageHeader";
import { PlacePicker } from "@/components/PlacePicker";
import { WeekPicker } from "@/components/WeekPicker";
import { useCropFarms } from "@/hooks/use-crop-farms";

export const ALL = "__all__";
const fromAll = (v: string) => (v === ALL ? "" : v);

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
  /** Hide the single-select Farm dropdown (e.g. when the page provides its
   *  own multi-select farm picker). */
  showFarm?: boolean;
  rightSlot?: ReactNode;
  /** Pill switcher rendered on the left of the controls row. */
  switcher?: ReactNode;
}

export function RangeHeader({
  title,
  subtitle,
  value,
  onChange,
  showGreenhouse = true,
  showFarm = true,
  rightSlot,
  switcher,
}: RangeHeaderProps) {
  // Farms for the route crop only, narrowed on the server (spec D3).
  const { farms, loading } = useCropFarms(value.crop);

  return (
    <PageHeader title={title} eyebrow={subtitle} switcher={switcher}>
      {/* One place pill (place picker spec G1); the page keeps ALL as "all". */}
      {showFarm && (
        <PlacePicker
          farms={farms}
          crop={value.crop}
          level={showGreenhouse ? "both" : "farm"}
          value={{ farm: fromAll(value.farm), greenhouse: showGreenhouse ? fromAll(value.greenhouse) : "" }}
          onChange={(p) => onChange({ ...value, farm: p.farm || ALL, greenhouse: p.greenhouse || ALL })}
          disabled={loading}
        />
      )}

      <WeekPicker
        value={{ from: value.from, to: value.to }}
        onChange={(r) => onChange({ ...value, from: r.from, to: r.to })}
      />

      {rightSlot}
    </PageHeader>
  );
}
