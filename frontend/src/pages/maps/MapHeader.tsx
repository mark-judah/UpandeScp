import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { HeaderIconButton } from "@/components/header-controls";
import { PlacePicker } from "@/components/PlacePicker";
import { DateRangePicker } from "@/components/DateRangePicker";
import { useCropFarms } from "@/hooks/use-crop-farms";

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
  // Farms for the route crop only, narrowed on the server (spec D3).
  const { farms, loading } = useCropFarms(value.crop);
  const farmList = Object.keys(farms);

  // Single-farm crop (e.g. avocado → Lokitela): auto-select that farm on load
  // instead of leaving it on "All farms" — several map layers (orchard trees,
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
      {/* One place pill (place picker spec G1); the page keeps ALL as "all". */}
      <PlacePicker
        farms={farms}
        crop={value.crop}
        level={showGreenhouse ? "both" : "farm"}
        value={{ farm: fromAll(value.farm), greenhouse: showGreenhouse ? fromAll(value.greenhouse) : "" }}
        onChange={(p) => onChange({ ...value, farm: p.farm || ALL, greenhouse: p.greenhouse || ALL })}
        disabled={loading}
      />

      <DateRangePicker
        label="Date range"
        value={{ from: value.from, to: value.to }}
        onChange={(r) => onChange({ ...value, from: r.from, to: r.to })}
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
