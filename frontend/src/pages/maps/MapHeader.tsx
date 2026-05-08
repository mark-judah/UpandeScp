import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { DatePicker } from "@/components/DatePicker";
import {
  fetchCrops,
  fetchFarmsAndWarehouses,
  DEFAULT_CROP,
} from "@/lib/scouting-api";

export const ALL = "__all__";

export interface MapFilterValue {
  crop: string;
  farm: string; // ALL or farm name
  greenhouse: string; // ALL or greenhouse name
  from: string;
  to: string;
}

export interface MapHeaderProps {
  title: string;
  subtitle: string;
  value: MapFilterValue;
  onChange: (next: MapFilterValue) => void;
  onReload?: () => void;
  showGreenhouse?: boolean;
  /** When true, the farm picker only includes farms whose warehouses are
   *  block-typed (avocado-style); used by the Avocado map. */
  blocksOnly?: boolean;
  rightSlot?: React.ReactNode;
}

/**
 * Shared header for every scouting map page.
 *
 * Filters always reuse the cached reference data (crops, farms, greenhouses)
 * — no map page hits these endpoints directly. The crop / farm / greenhouse
 * selections cascade exactly the way the dashboard does.
 */
export function MapHeader({
  title,
  subtitle,
  value,
  onChange,
  onReload,
  showGreenhouse = true,
  rightSlot,
}: MapHeaderProps) {
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
    const cropAllow = crops.find((c) => c.crop_name === value.crop)?.farms || [];
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
            <Label>From</Label>
            <DatePicker
              value={value.from}
              onChange={(v) => onChange({ ...value, from: v })}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label>To</Label>
            <DatePicker
              value={value.to}
              onChange={(v) => onChange({ ...value, to: v })}
            />
          </div>

          {onReload && (
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={onReload}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reload
            </Button>
          )}

          {rightSlot}
        </div>
      </div>
    </header>
  );
}
