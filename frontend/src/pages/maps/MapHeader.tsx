import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PlacePicker } from "@/components/PlacePicker";
import { useCropFarms } from "@/hooks/use-crop-farms";
import { PageHeader } from "@/components/PageHeader";
import { HEADER_PILL, HeaderIconButton } from "@/components/header-controls";
import { DatePicker } from "@/components/DatePicker";
import {
  fetchCrops,
  DEFAULT_CROP,
} from "@/lib/scouting-api";

export const ALL = "__all__";
const fromAll = (v: string) => (v === ALL ? "" : v);

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
  // Farms for the crop only, narrowed on the server.
  const { farms, loading: farmsLoading } = useCropFarms(value.crop);
  const farmList = Object.keys(farms);

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
  }, []);

  // Single-farm crop (e.g. avocado → Lokitela): auto-select that farm on load
  // instead of leaving it on "All Farms" — several map layers (orchard trees,
  // per-farm geometry) only load once a specific farm is chosen. Done once, and
  // only while the picker is still untouched (ALL), so it never fights the user.
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (value.farm === ALL && farmList.length === 1) {
      autoSelectedRef.current = true;
      onChange({ ...value, farm: farmList[0], greenhouse: ALL });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmList.length]);

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

      <PlacePicker
        farms={farms}
        crop={value.crop}
        level={showGreenhouse ? "both" : "farm"}
        value={{ farm: fromAll(value.farm), greenhouse: showGreenhouse ? fromAll(value.greenhouse) : "" }}
        onChange={(p) => onChange({ ...value, farm: p.farm || ALL, greenhouse: p.greenhouse || ALL })}
        disabled={farmsLoading}
      />

      <DatePicker
        value={value.from}
        onChange={(v) => onChange({ ...value, from: v })}
      />
      <DatePicker
        value={value.to}
        onChange={(v) => onChange({ ...value, to: v })}
      />

      {onReload && (
        <HeaderIconButton
          onClick={onReload}
          aria-label="Reload"
          tooltip="Fetch the latest scouting entries for this window"
        >
          <RefreshCw className="h-4 w-4" />
        </HeaderIconButton>
      )}

      {rightSlot}
    </PageHeader>
  );
}
