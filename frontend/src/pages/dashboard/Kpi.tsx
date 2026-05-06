import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

interface KpiProps {
  label: string
  value: string
  hint?: string
  accent?:
    | "chart-1"
    | "chart-2"
    | "chart-3"
    | "chart-4"
    | "chart-5"
    | "severity-low"
    | "severity-mod"
    | "severity-high"
}

const accentVar: Record<NonNullable<KpiProps["accent"]>, string> = {
  "chart-1": "var(--chart-1)",
  "chart-2": "var(--chart-2)",
  "chart-3": "var(--chart-3)",
  "chart-4": "var(--chart-4)",
  "chart-5": "var(--chart-5)",
  "severity-low": "var(--severity-low)",
  "severity-mod": "var(--severity-mod)",
  "severity-high": "var(--severity-high)",
}

export function Kpi({ label, value, hint, accent }: KpiProps) {
  const color = accent ? accentVar[accent] : undefined
  return (
    <Card className="relative overflow-hidden">
      {color && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-1"
          style={{ background: color }}
        />
      )}
      <CardHeader className="pb-2">
        <CardDescription className="text-xs uppercase tracking-wide">
          {label}
        </CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}
