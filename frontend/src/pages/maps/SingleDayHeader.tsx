/**
 * Single-day header for map pages that show one scouting date at a time
 * (Observations, Rose Scouting). Keeps Crop / Farm / Greenhouse cascading
 * via the same cached reference data the rest of the SPA uses, but
 * exposes a single ``date`` field instead of the from/to range that
 * MapHeader uses — multi-day overlap on these pages turns the map into
 * spaghetti, so the legacy www pages always picked one day.
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
import { DatePicker } from "@/components/DatePicker";
import { useCropFarms } from "@/hooks/use-crop-farms";

export const ALL = "__all__";

export interface SingleDayFilterValue {
  crop: string;
  farm: string;
  greenhouse: string;
  date: string;
}

export interface SingleDayHeaderProps {
  title: string;
  subtitle: string;
  value: SingleDayFilterValue;
  onChange: (next: SingleDayFilterValue) => void;
  showGreenhouse?: boolean;
  /** Hide the crop picker — the crop is fixed by the route. */
  rightSlot?: ReactNode;
}

export function SingleDayHeader({
  title,
  subtitle,
  value,
  onChange,
  showGreenhouse = true,
  rightSlot,
}: SingleDayHeaderProps) {
  // Farms for the route crop only, narrowed on the server (spec D3).
  const { farms } = useCropFarms(value.crop);
  const farmList = Object.keys(farms);

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
            <Label>Date</Label>
            <DatePicker
              value={value.date}
              onChange={(v) => onChange({ ...value, date: v })}
            />
          </div>

          {rightSlot}
        </div>
      </div>
    </header>
  );
}
