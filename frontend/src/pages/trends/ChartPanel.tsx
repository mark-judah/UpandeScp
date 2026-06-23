import { useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { Download, FileText } from "lucide-react";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { weekTickFormatter } from "@/lib/iso-week";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  exportChartAsPng,
  printChartAsPdf,
  slugifyForFile,
} from "@/lib/chart-export";
import type { ObsKey, Selection, TrendsPayload } from "./trends-types";
import { buildSeries, type MatrixIndex } from "./aggregate";

function SideLegend({
  items,
  hovered,
  onEnter,
  onLeave,
}: {
  items: Array<{ key: string; label: string; color: string }>;
  hovered: string | null;
  onEnter: (v: string) => void;
  onLeave: () => void;
}) {
  if (!items.length) return null;
  return (
    <ul className="flex flex-col gap-1.5 max-h-full overflow-auto pr-1">
      {items.map((item) => {
        const isHover = hovered === item.key;
        const dim = hovered != null && !isHover;
        return (
          <li
            key={item.key}
            onMouseEnter={() => onEnter(item.key)}
            onMouseLeave={onLeave}
            className={cn(
              "flex items-center gap-2 text-xs cursor-pointer transition-opacity leading-tight",
              dim ? "opacity-40" : "opacity-100",
              isHover && "font-medium",
            )}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: item.color }}
            />
            <span className="text-muted-foreground truncate">{item.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

const PALETTE = [
  "var(--sd-data-cyan)",
  "var(--sd-data-pink)",
  "var(--sd-data-purple)",
  "var(--sd-data-amber)",
  "var(--sd-data-green)",
  "var(--sd-data-indigo)",
  "var(--sd-data-red)",
];

export interface ThresholdBand {
  low?: number;
  moderate?: number;
  high?: number;
}

/** Render a Recharts ReferenceLine label as a small SVG ``<g>`` with a
 *  native ``<title>`` child — that gives the user a hover tooltip
 *  reading "<Tier> threshold for <Pest>: <pct>%" without having to
 *  build a custom tooltip overlay. Positioned at the right edge of the
 *  reference line just inside the chart area. */
function renderThresholdLabel(
  tier: "Low" | "Moderate" | "High",
  value: number,
  obsLabel: string,
  stage: string | undefined,
  color: string,
) {
  const tip = stage
    ? `${tier} threshold · ${obsLabel} · ${stage}: ${value}%`
    : `${tier} threshold · ${obsLabel}: ${value}%`;
  // Recharts passes the line's viewBox via the ``props`` arg.
  return (props: { viewBox?: { x?: number; y?: number; width?: number } }) => {
    const vb = props.viewBox || {};
    const x = (vb.x || 0) + (vb.width || 0) - 4;
    const y = (vb.y || 0) - 2;
    return (
      <g style={{ pointerEvents: "all" }}>
        <title>{tip}</title>
        <text
          x={x}
          y={y}
          textAnchor="end"
          fill={color}
          fontSize={10}
          fontWeight={600}
        >
          {tier === "Moderate" ? "Mod" : tier} {value}%
        </text>
      </g>
    );
  };
}

export interface ThresholdLookup {
  /** kind→name→stage→band. Empty stage key = aggregate fallback. */
  (kind: "pest" | "disease", name: string, stage: string): ThresholdBand | null;
}

/** Adaptive Y-axis ceiling (a percentage). Picks the smallest "nice" value
 *  above the data max plus ~15% headroom, so a chart that tops out at ~6%
 *  zooms to a 10% axis instead of wasting the 0–100% range. Capped at 100. */
const NICE_PCT_STEPS = [1, 2, 3, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100];
export function niceCeilPercent(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const withHeadroom = v * 1.15;
  for (const step of NICE_PCT_STEPS) if (step >= withHeadroom) return step;
  return 100;
}

export function ChartPanel({
  payload,
  index,
  selections,
  obs,
  stages,
  child,
  thresholdLookup,
  showThresholds,
}: {
  payload: TrendsPayload;
  index: MatrixIndex;
  selections: Selection[];
  obs: ObsKey | null;
  stages: string[];
  child?: { stage: string };
  thresholdLookup?: ThresholdLookup;
  showThresholds?: boolean;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Hover highlight: while a line is under the cursor we thicken it and dim
  // its siblings. The leave handler is debounced because Recharts' moving
  // activeDot briefly steals the cursor — without the delay, leaving and
  // re-entering on every frame caused the chart to flicker.
  const [hovered, setHovered] = useState<string | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enter = (key: string) => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    setHovered(key);
  };
  const leave = () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      setHovered(null);
      leaveTimer.current = null;
    }, 120);
  };
  const seriesData = useMemo(
    () => buildSeries(payload, index, selections, obs, child?.stage || null),
    [payload, index, selections, obs, child?.stage],
  );
  const config = useMemo<ChartConfig>(() => {
    const c: ChartConfig = {};
    selections.forEach((s, i) => {
      c[s.label] = { label: s.label, color: PALETTE[i % PALETTE.length] };
    });
    return c;
  }, [selections]);

  const title = obs ? obs.label : "All Observations";
  const tag = obs ? (obs.kind === "pest" ? "Pest" : "Disease") : "Mixed";

  // Reference to the recharts wrapper so we can serialise the SVG when
  // the operator hits Export. Lives at the CardContent level — the
  // Card itself includes the title chrome we don't want in the export.
  const exportRef = useRef<HTMLDivElement | null>(null);
  const baseFilename = slugifyForFile(
    child ? `${title}-${child.stage}` : title,
  );
  const exportTitle = child ? `${title} · ${child.stage}` : title;

  const legendItems = useMemo(
    () =>
      selections.map((s, i) => ({
        label: s.kind === "farm" ? `${s.label} (farm)` : s.label,
        color: PALETTE[i % PALETTE.length],
      })),
    [selections],
  );

  // Resolve the threshold band for this panel: stage child uses the
  // stage's band, the parent panel uses the aggregate band. No band
  // when the user is on "All Observations" (mixed) — averaging
  // thresholds across pests would be misleading.
  const band: ThresholdBand | null = useMemo(() => {
    if (!showThresholds || !thresholdLookup || !obs) return null;
    return thresholdLookup(obs.kind, obs.name, child?.stage || "");
  }, [showThresholds, thresholdLookup, obs, child?.stage]);

  // Adaptive Y-axis ceiling: fit the data (and any visible threshold band)
  // with headroom instead of a fixed 0–100%. Applies to every trends chart
  // uniformly, so low-coverage crops (avocado) and high-coverage ones (roses)
  // each get a readable scale.
  const yMax = useMemo(() => {
    let max = 0;
    for (const point of seriesData) {
      for (const k in point) {
        if (k === "date") continue;
        const v = point[k];
        if (typeof v === "number" && v > max) max = v;
      }
    }
    if (band) {
      max = Math.max(max, band.high ?? 0, band.moderate ?? 0, band.low ?? 0);
    }
    return niceCeilPercent(max);
  }, [seriesData, band]);

  const onPng = async () => {
    const node = exportRef.current;
    if (!node) return;
    try {
      await exportChartAsPng(node, baseFilename, {
        title: exportTitle,
        badge: tag,
        legend: legendItems,
      });
    } catch (e) {
      console.error("[trends] PNG export failed", e);
    }
  };
  const onPdf = () => {
    const node = exportRef.current;
    if (!node) return;
    printChartAsPdf(node, exportTitle, { badge: tag, legend: legendItems });
  };

  return (
    <Card className={cn("p-4", child && "ml-8")}>
      <CardHeader className="p-0 pb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <CardTitle>{child ? `${title} · ${child.stage}` : title}</CardTitle>
          <Badge variant="outline" className="text-[0.65rem]">
            {tag}
          </Badge>
          <CardDescription className="ml-auto">
            {selections.length} selection
            {selections.length !== 1 ? "s" : ""} · %{" "}
            {payload.unitLabelPlural || "zones"} with matching observations
          </CardDescription>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[0.7rem] gap-1.5"
              onClick={onPng}
              title="Download chart as PNG"
            >
              <Download className="h-3 w-3" />
              PNG
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[0.7rem] gap-1.5"
              onClick={onPdf}
              title="Open print dialog — choose 'Save as PDF'"
            >
              <FileText className="h-3 w-3" />
              PDF
            </Button>
          </div>
        </div>
        {!child && stages.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
              Stages:
            </span>
            {stages.map((s) => {
              const on = picked.has(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(s)) next.delete(s);
                      else next.add(s);
                      return next;
                    })
                  }
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs border transition-colors",
                    on
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-card text-muted-foreground hover:bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "h-2.5 w-2.5 rounded-sm border",
                      on ? "bg-white border-white" : "border-current",
                    )}
                  />
                  {s}
                </button>
              );
            })}
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        <div ref={exportRef} className="flex flex-col gap-3">
        <div
          className="flex flex-col md:flex-row gap-3 items-stretch"
        >
          <div className="flex-1 min-w-0">
            <ChartContainer
              config={config}
              className={cn("w-full", child ? "h-48" : "h-64")}
            >
              <LineChart
                data={seriesData}
                margin={{ left: 4, right: 8, top: 8 }}
                onMouseLeave={leave}
              >
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  interval={0}
                  minTickGap={0}
                  tickFormatter={weekTickFormatter}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={36}
                  domain={[0, yMax]}
                  allowDecimals={yMax <= 5}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      indicator="line"
                      formatter={(v) => `${v}%`}
                    />
                  }
                />
                {band && band.low ? (
                  <ReferenceLine
                    y={band.low}
                    stroke="var(--sd-data-green, #16a34a)"
                    strokeDasharray="4 3"
                    strokeWidth={1.2}
                    ifOverflow="extendDomain"
                    label={renderThresholdLabel(
                      "Low",
                      band.low,
                      obs?.label || title,
                      child?.stage,
                      "var(--sd-data-green, #16a34a)",
                    )}
                  />
                ) : null}
                {band && band.moderate ? (
                  <ReferenceLine
                    y={band.moderate}
                    stroke="var(--sd-target, #d97706)"
                    strokeDasharray="4 3"
                    strokeWidth={1.2}
                    ifOverflow="extendDomain"
                    label={renderThresholdLabel(
                      "Moderate",
                      band.moderate,
                      obs?.label || title,
                      child?.stage,
                      "var(--sd-target, #d97706)",
                    )}
                  />
                ) : null}
                {band && band.high ? (
                  <ReferenceLine
                    y={band.high}
                    stroke="var(--sd-data-red, #dc2626)"
                    strokeDasharray="4 3"
                    strokeWidth={1.4}
                    ifOverflow="extendDomain"
                    label={renderThresholdLabel(
                      "High",
                      band.high,
                      obs?.label || title,
                      child?.stage,
                      "var(--sd-data-red, #dc2626)",
                    )}
                  />
                ) : null}
                {selections.map((s, i) => {
                  const isHover = hovered === s.label;
                  const dim = hovered != null && !isHover;
                  return (
                    <Line
                      key={`${s.kind}:${s.label}`}
                      type="linear"
                      dataKey={s.label}
                      name={s.kind === "farm" ? `${s.label} (farm)` : s.label}
                      stroke={PALETTE[i % PALETTE.length]}
                      strokeWidth={isHover ? 3 : 2}
                      strokeOpacity={dim ? 0.25 : 1}
                      dot={false}
                      activeDot={{ r: isHover ? 5 : 3 }}
                      connectNulls
                      isAnimationActive={false}
                      onMouseEnter={() => enter(s.label)}
                      onMouseLeave={leave}
                    />
                  );
                })}
              </LineChart>
            </ChartContainer>
          </div>
          <div className="md:w-48 shrink-0 md:border-l md:pl-3 pt-2 md:pt-0">
            <SideLegend
              items={selections.map((s, i) => ({
                key: s.label,
                label: s.kind === "farm" ? `${s.label} (farm)` : s.label,
                color: PALETTE[i % PALETTE.length],
              }))}
              hovered={hovered}
              onEnter={enter}
              onLeave={leave}
            />
          </div>
        </div>
        {!child &&
          Array.from(picked).map((stage) => (
            <div key={stage} className="mt-3">
              <ChartPanel
                payload={payload}
                index={index}
                selections={selections}
                obs={obs}
                stages={[]}
                child={{ stage }}
                thresholdLookup={thresholdLookup}
                showThresholds={showThresholds}
              />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
