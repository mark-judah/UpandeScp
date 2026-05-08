import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  buildGreenhouseUprightSvg,
  type ZoneGeo,
  type ZoneObs,
} from "@/pages/maps/upright-svg";

/**
 * Renders the same upright-view SVG you see in the observations map
 * gh-modal: a horizontal layout of bed-segment polylines, colored by the
 * per-zone observation count for the active filter. Click a zone to
 * receive its name via ``onSelectZone``.
 */
export interface UprightHeatmapProps {
  zones: ZoneGeo[];
  zoneObs: Record<string, ZoneObs>;
  className?: string;
  onSelectZone?: (zoneName: string) => void;
}

export function UprightHeatmap({
  zones,
  zoneObs,
  className,
  onSelectZone,
}: UprightHeatmapProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const built = useMemo(
    () => buildGreenhouseUprightSvg(zones, zoneObs),
    [zones, zoneObs],
  );

  // Click handler: re-attached after each render because innerHTML rewrites
  // wipe listeners. Cheap — one delegated listener on the wrapper.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !onSelectZone) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const z = t.closest?.(".gh-zone") as SVGElement | null;
      const zoneName = z?.getAttribute("data-zone");
      if (zoneName) onSelectZone(zoneName);
    };
    wrap.addEventListener("click", onClick);
    return () => wrap.removeEventListener("click", onClick);
  }, [onSelectZone, built]);

  if (!built) {
    return (
      <div
        className={cn(
          "flex items-center justify-center text-xs text-muted-foreground border rounded-md bg-[var(--sd-bg-soft)]",
          "min-h-[420px]",
          className,
        )}
      >
        No zone geometry available for this greenhouse.
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      className={cn(
        "rounded-md border bg-card overflow-hidden p-2",
        "[&_.gh-bed-baseline]:stroke-[var(--sd-line)] [&_.gh-bed-baseline]:[stroke-width:1]",
        "[&_.gh-bed-label]:fill-[var(--sd-muted)] [&_.gh-bed-label]:[font-size:9px] [&_.gh-bed-label]:[font-family:var(--sd-font)]",
        "[&_.gh-zone]:cursor-pointer [&_.gh-zone:hover]:brightness-90",
        className,
      )}
      // Inject the SVG markup verbatim — `built.svg` is a self-contained
      // <svg> root with all polylines pre-escaped.
      dangerouslySetInnerHTML={{ __html: built.svg }}
    />
  );
}
