import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/PageHeader";
import { HEADER_PILL, HeaderIconButton } from "@/components/header-controls";
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
  /** Hide the crop picker — the crop is fixed by the route (one crop per
   *  section), so the picker would be redundant. */
  showCrop?: boolean;
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
  showCrop = true,
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
    <PageHeader title={title} eyebrow={subtitle}>
      {showCrop && (
        <Select
          value={value.crop}
          onValueChange={(v) =>
            onChange({ ...value, crop: v, farm: ALL, greenhouse: ALL })
          }
        >
          <SelectTrigger aria-label="Crop" className={HEADER_PILL}>
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
      )}

      <Select
        value={value.farm}
        onValueChange={(v) => onChange({ ...value, farm: v, greenhouse: ALL })}
      >
        <SelectTrigger aria-label="Farm" className={HEADER_PILL}>
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

      {showGreenhouse && (
        <Select
          value={value.greenhouse}
          onValueChange={(v) => onChange({ ...value, greenhouse: v })}
          disabled={!greenhouseList.length}
        >
          <SelectTrigger aria-label="Greenhouse" className={HEADER_PILL}>
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
      )}

      <DatePicker
        value={value.from}
        onChange={(v) => onChange({ ...value, from: v })}
      />
      <DatePicker
        value={value.to}
        onChange={(v) => onChange({ ...value, to: v })}
      />

      {onReload && (
        <HeaderIconButton onClick={onReload} title="Reload">
          <RefreshCw className="h-4 w-4" />
        </HeaderIconButton>
      )}

      {rightSlot}
    </PageHeader>
  );
}
