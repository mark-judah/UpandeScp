import * as React from "react";
import * as Recharts from "recharts";
import { cn } from "@/lib/utils";

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    color?: string;
    icon?: React.ComponentType;
  }
>;

type ChartContextValue = { config: ChartConfig; id: string };

const ChartContext = React.createContext<ChartContextValue | null>(null);

export function useChart() {
  const ctx = React.useContext(ChartContext);
  if (!ctx) throw new Error("useChart must be used within <ChartContainer />");
  return ctx;
}

let chartIdCounter = 0;
function useChartId() {
  const [id] = React.useState(() => `chart-${++chartIdCounter}`);
  return id;
}

export const ChartContainer = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    config: ChartConfig;
    children: React.ReactNode;
  }
>(({ id: idProp, className, children, config, ...props }, ref) => {
  const fallback = useChartId();
  const id = idProp || fallback;

  const styleVars = React.useMemo(() => {
    const vars: Record<string, string> = {};
    Object.entries(config).forEach(([key, cfg]) => {
      if (cfg.color) vars[`--color-${key}`] = cfg.color;
    });
    return vars as React.CSSProperties;
  }, [config]);

  return (
    <ChartContext.Provider value={{ config, id }}>
      <div
        ref={ref}
        data-chart={id}
        style={styleVars}
        className={cn(
          "flex aspect-video w-full justify-center text-xs",
          "[&_.recharts-cartesian-axis-tick_text]:fill-[var(--sd-muted)]",
          "[&_.recharts-cartesian-grid_line]:stroke-[var(--sd-line)]",
          "[&_.recharts-polar-grid_line]:stroke-[var(--sd-line)]",
          "[&_.recharts-radial-bar-background-sector]:fill-[var(--sd-bg-soft)]",
          "[&_.recharts-reference-line_line]:stroke-[var(--sd-line)]",
          "[&_.recharts-tooltip-cursor]:stroke-[var(--sd-line)]",
          "[&_.recharts-sector]:outline-none",
          "[&_.recharts-surface]:outline-none",
          className,
        )}
        {...props}
      >
        <Recharts.ResponsiveContainer>
          {children as any}
        </Recharts.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
});
ChartContainer.displayName = "ChartContainer";

export const ChartTooltip = Recharts.Tooltip;

export type ChartTooltipContentProps = {
  active?: boolean;
  payload?: Array<{
    name?: string;
    value?: number | string;
    color?: string;
    dataKey?: string;
    payload?: Record<string, unknown>;
  }>;
  label?: string | number;
  hideLabel?: boolean;
  hideIndicator?: boolean;
  indicator?: "dot" | "line";
  className?: string;
  labelFormatter?: (label: unknown, payload: unknown[]) => React.ReactNode;
  formatter?: (
    value: unknown,
    name: unknown,
    item: unknown,
    index: number,
  ) => React.ReactNode;
  nameKey?: string;
  labelKey?: string;
};

export function ChartTooltipContent({
  active,
  payload,
  label,
  hideLabel,
  hideIndicator,
  indicator = "dot",
  labelFormatter,
  formatter,
  className,
}: ChartTooltipContentProps) {
  const { config } = useChart();
  if (!active || !payload || !payload.length) return null;

  return (
    <div
      className={cn(
        "min-w-[8rem] rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md",
        className,
      )}
    >
      {!hideLabel && label != null && (
        <div className="mb-1 font-medium text-foreground">
          {labelFormatter ? labelFormatter(label, payload) : String(label)}
        </div>
      )}
      <div className="grid gap-1">
        {payload.map((item, i) => {
          const key = item.name || item.dataKey || "";
          const cfg = (config as ChartConfig)[String(key)];
          const color = item.color || cfg?.color;
          return (
            <div
              key={String(key) + i}
              className="flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-1.5">
                {!hideIndicator && (
                  <span
                    className={cn(
                      "shrink-0 rounded-full",
                      indicator === "dot" ? "h-2 w-2" : "h-2 w-3 rounded-sm",
                    )}
                    style={{ background: color }}
                  />
                )}
                <span className="text-muted-foreground">
                  {cfg?.label ?? String(key)}
                </span>
              </div>
              <span className="font-mono font-medium tabular-nums text-foreground">
                {formatter
                  ? formatter(item.value, key, item, i)
                  : typeof item.value === "number"
                    ? new Intl.NumberFormat().format(item.value)
                    : String(item.value)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const ChartLegend = Recharts.Legend;

export function ChartLegendContent({
  payload,
  className,
}: {
  payload?: Array<{ value?: string; color?: string; dataKey?: string }>;
  className?: string;
}) {
  const { config } = useChart();
  if (!payload || !payload.length) return null;
  return (
    <ul
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", className)}
    >
      {payload.map((item, i) => {
        const key = item.value || item.dataKey || "";
        const cfg = (config as ChartConfig)[String(key)];
        return (
          <li
            key={String(key) + i}
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: item.color }}
            />
            {cfg?.label ?? String(key)}
          </li>
        );
      })}
    </ul>
  );
}
