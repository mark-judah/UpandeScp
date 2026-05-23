/**
 * Labels — dynamic-size QR label printer for the Store Keeper.
 *
 * Pick submitted Material-Transfer Stock Entries, choose a label width
 * × height (preset or custom mm), choose thermal vs A4-tile output,
 * preview one label live, then download the PDF. The preview mirrors
 * the same tier rules the backend renderer uses, so what you see is
 * what prints.
 *
 * Backend:
 *   list_submitted_transfers     → the selection-tree dataset
 *   spray_plan_labels.generate_pdf → the PDF
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Printer,
  RefreshCw,
  Loader2,
  QrCode,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/DatePicker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fetchSubmittedTransfers,
  generateLabelPdf,
  downloadBase64Pdf,
  type Orientation,
  type OutputMode,
  type SubmittedTransferRow,
} from "@/lib/labels-api";
import { planLabel, MIN_DIM_FLOOR_MM } from "@/lib/label-tiers";
import { cn } from "@/lib/utils";

const ALL_FARMS = "__all__";
const CUSTOM = "__custom__";

// Preset sizes — width × height in mm. Ordered roughly by use frequency.
const PRESETS = [
  { id: "100x50", label: "100 × 50 mm (standard)", w: 100, h: 50 },
  { id: "50x25",  label: "50 × 25 mm (small)",     w: 50,  h: 25 },
  { id: "102x152", label: "102 × 152 mm (4×6 thermal)", w: 102, h: 152 },
  { id: "40x30",  label: "40 × 30 mm (bunch tag)",  w: 40,  h: 30 },
  { id: "70x40",  label: "70 × 40 mm",              w: 70,  h: 40 },
];

const DEFAULT_PRESET = PRESETS[0];

// Discrete text-size steps so the operator gets predictable output —
// a free-form slider lets them pick noisy fractions that don't tile
// nicely on small labels. Multiplier applies to base AND head sizes.
const FONT_SCALES = [
  { id: "tiny",   label: "Tiny (0.7×)",    value: 0.7 },
  { id: "small",  label: "Small (0.85×)",  value: 0.85 },
  { id: "normal", label: "Normal (1.0×)",  value: 1.0 },
  { id: "large",  label: "Large (1.2×)",   value: 1.2 },
];

const DEFAULT_FONT_SCALE = FONT_SCALES[2]; // Normal

// A placeholder QR pattern for the live preview. The real QR comes from
// the SE's image attachment and is embedded server-side at PDF time.
function QrPlaceholder({ sideMm }: { sideMm: number }) {
  // 7×7 grid is enough to look QR-ish; a real one is 21×21+ but this
  // is just a positional/sizing preview.
  const mod = 7;
  const cells: boolean[] = [];
  for (let i = 0; i < mod * mod; i++) {
    // Three finder squares + a smattering of dark cells. Deterministic.
    const r = Math.floor(i / mod);
    const c = i % mod;
    const inFinder =
      (r < 3 && c < 3) || (r < 3 && c >= mod - 3) || (r >= mod - 3 && c < 3);
    const dot = inFinder
      ? !((r === 1 && c === 1) ||
          (r === 1 && c === mod - 2) ||
          (r === mod - 2 && c === 1))
      : ((i * 13) % 5) === 0;
    cells.push(dot);
  }
  return (
    <svg
      viewBox={`0 0 ${mod} ${mod}`}
      style={{ width: `${sideMm}mm`, height: `${sideMm}mm` }}
      shapeRendering="crispEdges"
      aria-label="QR placeholder"
    >
      <rect width={mod} height={mod} fill="#fff" />
      {cells.map((v, i) =>
        v ? (
          <rect
            key={i}
            x={i % mod}
            y={Math.floor(i / mod)}
            width={1}
            height={1}
            fill="#000"
          />
        ) : null,
      )}
    </svg>
  );
}

// Sample data for the preview — picked to look reasonable across tiers.
const SAMPLE = {
  se_name: "STE-2026-00042",
  chem_name: "Pyretone 40EC",
  qty: "1 L",
  source: "Chemical Store Kapkolia",
  target: "Kapkolia GH 04",
  scheduled: "31 May 2026 09:00",
  spray_type: "Full",
};

function QrImage({ src, sideMm }: { src: string; sideMm: number }) {
  return (
    <img
      src={src}
      style={{
        width: `${sideMm}mm`,
        height: `${sideMm}mm`,
        objectFit: "contain",
        display: "block",
        margin: "0 auto",
      }}
      alt="QR"
    />
  );
}

function PreviewLabel({
  widthMm,
  heightMm,
  fontScale,
  qrUrl,
}: {
  widthMm: number;
  heightMm: number;
  fontScale: number;
  qrUrl?: string;
}) {
  const rawPlan = useMemo(() => planLabel(widthMm, heightMm), [widthMm, heightMm]);
  // Apply the user's font multiplier on top of the tier defaults so
  // the preview stays in lockstep with what the PDF renderer does
  // server-side (same clamp + same multiplication).
  const plan = useMemo(() => {
    const s = Math.max(0.5, Math.min(1.6, fontScale));
    return {
      ...rawPlan,
      basePt: Math.round(rawPlan.basePt * s * 100) / 100,
      headPt: Math.round(rawPlan.headPt * s * 100) / 100,
    };
  }, [rawPlan, fontScale]);

  const isXs = plan.tier === "xs" || plan.fields.length === 0;

  // The preview renders at real-world mm via inline styles. The parent
  // Card scales the whole block to fit the available width by setting a
  // CSS zoom on the wrapper.
  const baseStyle = {
    width: `${widthMm}mm`,
    height: `${heightMm}mm`,
    boxSizing: "border-box" as const,
    padding: isXs ? "0.5mm" : "1.2mm",
    fontSize: `${plan.basePt}pt`,
    border: "1px solid hsl(var(--border))",
    background: "white",
    color: "black",
    overflow: "hidden",
    fontFamily: "'Poppins', Helvetica, Arial, sans-serif",
    display: "flex",
    flexDirection: isXs ? "column" : (plan.orientation === "row" ? "row" : "column"),
    alignItems: isXs ? "center" : (plan.orientation === "row" ? "center" : "stretch"),
    justifyContent: isXs ? "center" : "flex-start",
  } as React.CSSProperties;

  if (isXs) {
    // QR-only: scale QR to fill (capped by mins enforced by planLabel).
    return (
      <div style={baseStyle}>
        {qrUrl ? (
          <QrImage src={qrUrl} sideMm={plan.qrSideMm} />
        ) : (
          <QrPlaceholder sideMm={plan.qrSideMm} />
        )}
      </div>
    );
  }

  const kvRows: Array<[string, string]> = [];
  if (plan.fields.includes("qty")) kvRows.push(["Qty", SAMPLE.qty]);
  if (plan.fields.includes("from")) kvRows.push(["From", SAMPLE.source]);
  if (plan.fields.includes("to")) kvRows.push(["To", SAMPLE.target]);
  if (plan.fields.includes("sched")) kvRows.push(["Scheduled", SAMPLE.scheduled]);
  if (plan.fields.includes("type")) kvRows.push(["Type", SAMPLE.spray_type]);

  const showSe = plan.fields.includes("se");
  const showChem = plan.fields.includes("chem");

  return (
    <div style={baseStyle}>
      <div
        style={{
          flex: `0 0 ${plan.qrSideMm}mm`,
          paddingRight: plan.orientation === "row" ? "1.5mm" : 0,
          paddingBottom: plan.orientation === "stack" ? "0.8mm" : 0,
          textAlign: "center",
        }}
      >
        {qrUrl ? (
          <QrImage src={qrUrl} sideMm={plan.qrSideMm} />
        ) : (
          <QrPlaceholder sideMm={plan.qrSideMm} />
        )}
      </div>
      <div
        style={{
          flex: "1 1 auto",
          minWidth: 0,
          textAlign: plan.orientation === "stack" ? "center" : "left",
        }}
      >
        {showSe && (
          <div style={{ fontWeight: 700, fontSize: `${plan.headPt}pt`, lineHeight: 1.1 }}>
            {SAMPLE.se_name}
          </div>
        )}
        {showChem && (
          <div
            style={{
              fontWeight: 700,
              fontSize: `${Math.max(plan.headPt - 1, 6)}pt`,
              margin: "0.5mm 0 1mm",
              lineHeight: 1.15,
            }}
          >
            {SAMPLE.chem_name}
          </div>
        )}
        {kvRows.length > 0 && (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: `${plan.basePt}pt`,
            }}
          >
            <tbody>
              {kvRows.map(([k, v]) => (
                <tr key={k}>
                  <td
                    style={{
                      width: "38%",
                      color: "#444",
                      fontWeight: 600,
                      paddingRight: "1mm",
                      verticalAlign: "top",
                    }}
                  >
                    {k}
                  </td>
                  <td style={{ verticalAlign: "top", wordBreak: "break-word" }}>
                    {v}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function Labels() {
  const [rows, setRows] = useState<SubmittedTransferRow[]>([]);
  const [farms, setFarms] = useState<string[]>([]);
  const [farm, setFarm] = useState<string>(ALL_FARMS);
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Size state. ``preset`` of CUSTOM means the W/H inputs drive the
  // rendering; any other preset locks W/H to the preset values so the
  // operator can't accidentally drift mid-print.
  const [preset, setPreset] = useState<string>(DEFAULT_PRESET.id);
  const [widthMm, setWidthMm] = useState<number>(DEFAULT_PRESET.w);
  const [heightMm, setHeightMm] = useState<number>(DEFAULT_PRESET.h);
  const [outputMode, setOutputMode] = useState<OutputMode>("thermal");
  const [orientation, setOrientation] = useState<Orientation>("portrait");
  const [fontScaleId, setFontScaleId] = useState<string>(DEFAULT_FONT_SCALE.id);
  const fontScale =
    FONT_SCALES.find((f) => f.id === fontScaleId)?.value ?? 1.0;

  // Orientation normalises which dim is the page's width vs height.
  // Landscape ALWAYS gives a wide page (long-dim horizontal, QR on
  // the left, info on the right). Portrait ALWAYS gives a tall page.
  // This mirrors the backend so the preview matches the PDF.
  const longDim = Math.max(widthMm, heightMm);
  const shortDim = Math.min(widthMm, heightMm);
  const effWidthMm = orientation === "landscape" ? longDim : shortDim;
  const effHeightMm = orientation === "landscape" ? shortDim : longDim;

  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<{
    label_count: number;
    skipped_count: number;
  } | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchSubmittedTransfers({
      from_date: fromDate || undefined,
      to_date: toDate || undefined,
    })
      .then((r) => {
        setRows(r.rows);
        setFarms(r.farms);
        // Drop selections that no longer exist after a reload.
        setSelected((prev) => {
          const live = new Set(r.rows.map((x) => x.name));
          const next = new Set<string>();
          prev.forEach((n) => live.has(n) && next.add(n));
          return next;
        });
      })
      .catch((e) => setError(e?.message || "Failed to load transfers"))
      .finally(() => setLoading(false));
  };

  useEffect(load, [fromDate, toDate]);

  const visibleRows = useMemo(() => {
    if (farm === ALL_FARMS) return rows;
    return rows.filter((r) => (r.farm || "") === farm);
  }, [rows, farm]);

  // Group visible rows by greenhouse for the selection tree.
  const byGreenhouse = useMemo(() => {
    const map = new Map<string, SubmittedTransferRow[]>();
    visibleRows.forEach((r) => {
      const gh = r.greenhouse || "(Unknown greenhouse)";
      const list = map.get(gh) || [];
      list.push(r);
      map.set(gh, list);
    });
    return Array.from(map.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
  }, [visibleRows]);

  const totalSelectable = useMemo(
    () => visibleRows.filter((r) => r.has_qr).length,
    [visibleRows],
  );

  const selectableSelectedCount = useMemo(() => {
    let n = 0;
    for (const name of selected) {
      const row = rows.find((r) => r.name === name);
      if (row?.has_qr) n++;
    }
    return n;
  }, [selected, rows]);

  const toggleOne = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAllVisible = () => {
    const all = visibleRows.filter((r) => r.has_qr);
    const allSelected =
      all.length > 0 && all.every((r) => selected.has(r.name));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) all.forEach((r) => next.delete(r.name));
      else all.forEach((r) => next.add(r.name));
      return next;
    });
  };

  const toggleGreenhouse = (rowsForGh: SubmittedTransferRow[]) => {
    const eligible = rowsForGh.filter((r) => r.has_qr);
    const allSelected =
      eligible.length > 0 && eligible.every((r) => selected.has(r.name));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) eligible.forEach((r) => next.delete(r.name));
      else eligible.forEach((r) => next.add(r.name));
      return next;
    });
  };

  // ── Size-picker handlers ──────────────────────────────────────────
  const onPresetChange = (id: string) => {
    setPreset(id);
    if (id === CUSTOM) return;
    const p = PRESETS.find((x) => x.id === id);
    if (p) {
      setWidthMm(p.w);
      setHeightMm(p.h);
    }
  };

  const isCustom = preset === CUSTOM;

  // ── Validation ────────────────────────────────────────────────────
  const sizeError = useMemo(() => {
    if (widthMm < MIN_DIM_FLOOR_MM || heightMm < MIN_DIM_FLOOR_MM) {
      return `Width and height must each be at least ${MIN_DIM_FLOOR_MM}mm.`;
    }
    if (widthMm > 500 || heightMm > 500) {
      return "Width and height must each be 500mm or less.";
    }
    return null;
  }, [widthMm, heightMm]);

  // ── Generate ──────────────────────────────────────────────────────
  const generate = async () => {
    if (sizeError) {
      setError(sizeError);
      return;
    }
    const selectedRows = rows.filter(
      (r) => selected.has(r.name) && r.has_qr,
    );
    if (selectedRows.length === 0) {
      setError("Pick at least one transfer with a QR attachment.");
      return;
    }
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      const resp = await generateLabelPdf({
        seNames: selectedRows.map((r) => r.name),
        widthMm,
        heightMm,
        outputMode,
        orientation,
        fontScale,
      });
      setLastResult({
        label_count: resp.label_count,
        skipped_count: (resp.skipped || []).length,
      });
      if (resp.data && resp.filename) {
        downloadBase64Pdf(resp.data, resp.filename);
      } else {
        setError(
          "No labels generated — none of the selected transfers had a QR image attached.",
        );
      }
    } catch (e: any) {
      setError(e?.message || "Failed to generate PDF.");
    } finally {
      setBusy(false);
    }
  };

  // Preview scale — fit the (orientation-aware) preview within ~360px.
  const previewScale = useMemo(() => {
    const maxPx = 360;
    const mmToPx = 3.78; // ≈ 96dpi
    const naturalPx = effWidthMm * mmToPx;
    return Math.min(1, maxPx / Math.max(naturalPx, 1));
  }, [effWidthMm]);

  // Pick a QR image to show in the preview — the first selected row's
  // representative QR if anything's selected, else the first row with
  // a QR in the visible set so the operator still sees a real label
  // before they click anything.
  const previewQrUrl = useMemo(() => {
    for (const name of selected) {
      const row = rows.find((r) => r.name === name);
      if (row?.qr_image_url) return row.qr_image_url;
    }
    const fallback = visibleRows.find((r) => r.qr_image_url);
    return fallback?.qr_image_url || "";
  }, [selected, rows, visibleRows]);

  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-40 flex items-center gap-3 border-b bg-card/80 px-4 py-3 md:px-6 md:py-4 backdrop-blur">
        <SidebarTrigger />
        <Separator orientation="vertical" className="h-5" />
        <div className="flex-1">
          <h1 className="text-base font-semibold leading-tight">Labels</h1>
          <p className="text-xs text-muted-foreground">
            Print QR labels for submitted spray-plan transfers. Pick any
            size — the layout adapts.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={load}
          disabled={loading}
          className="gap-1"
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", loading && "animate-spin")}
          />
          Refresh
        </Button>
      </header>

      <div className="grid flex-1 grid-cols-1 lg:grid-cols-3 gap-4 p-4 md:p-6 lg:items-start">
        {/* ── Left: selection tree ─────────────────────────────── */}
        <Card className="lg:col-span-2 flex flex-col min-h-0">
          <CardHeader className="pb-3">
            <div className="flex items-end gap-3 flex-wrap">
              <div className="grid gap-1.5">
                <Label className="text-xs">Farm</Label>
                <Select value={farm} onValueChange={setFarm}>
                  <SelectTrigger className="h-8 w-44">
                    <SelectValue placeholder="All farms" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_FARMS}>All farms</SelectItem>
                    {farms.map((f) => (
                      <SelectItem key={f} value={f}>
                        {f}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">From</Label>
                <DatePicker value={fromDate} onChange={setFromDate} />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">To</Label>
                <DatePicker value={toDate} onChange={setToDate} />
              </div>
              <div className="ml-auto text-xs text-muted-foreground">
                {selectableSelectedCount} of {totalSelectable} selected
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto pt-0">
            {loading ? (
              <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading transfers…
              </div>
            ) : byGreenhouse.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No submitted transfers match this filter.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={
                      totalSelectable > 0 &&
                      selectableSelectedCount === totalSelectable
                    }
                    onCheckedChange={toggleAllVisible}
                    id="select-all"
                  />
                  <Label
                    htmlFor="select-all"
                    className="text-xs cursor-pointer"
                  >
                    Select all eligible ({totalSelectable})
                  </Label>
                </div>
                {byGreenhouse.map(([gh, ghRows]) => {
                  const eligible = ghRows.filter((r) => r.has_qr);
                  const ghAllSelected =
                    eligible.length > 0 &&
                    eligible.every((r) => selected.has(r.name));
                  return (
                    <div key={gh} className="rounded-md border bg-card">
                      <div className="flex items-center gap-2 px-3 py-2 bg-muted/40 border-b">
                        <Checkbox
                          checked={ghAllSelected}
                          onCheckedChange={() => toggleGreenhouse(ghRows)}
                        />
                        <span className="text-sm font-medium flex-1">{gh}</span>
                        <span className="text-xs text-muted-foreground">
                          {ghRows.length} transfer{ghRows.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                      <div className="divide-y">
                        {ghRows.map((r) => {
                          const checked = selected.has(r.name);
                          const dimmed = !r.has_qr;
                          return (
                            <label
                              key={r.name}
                              className={cn(
                                "flex items-center gap-2 px-3 py-2 text-sm",
                                dimmed
                                  ? "opacity-50 cursor-not-allowed"
                                  : "cursor-pointer hover:bg-muted/30",
                              )}
                              title={
                                dimmed
                                  ? "This transfer has no QR image attached"
                                  : ""
                              }
                            >
                              <Checkbox
                                checked={checked}
                                disabled={dimmed}
                                onCheckedChange={() =>
                                  !dimmed && toggleOne(r.name)
                                }
                              />
                              <span className="font-mono text-xs flex-1">
                                {r.name}
                              </span>
                              {r.spray_type && (
                                <Badge variant="outline" className="text-[10px]">
                                  {r.spray_type}
                                </Badge>
                              )}
                              <Badge variant="secondary" className="text-[10px]">
                                {r.qr_count} QR
                              </Badge>
                              <span className="text-xs text-muted-foreground">
                                {r.posting_date}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Right: size, preview, generate ───────────────────── */}
        {/* lg:sticky keeps the size picker + preview + Generate
            button in view even when the left selection tree scrolls
            far past the viewport. ``top`` accounts for the header. */}
        <div className="flex flex-col gap-4 lg:sticky lg:top-[88px] lg:max-h-[calc(100svh-104px)] lg:overflow-y-auto">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Label size</CardTitle>
              <CardDescription className="text-xs">
                Pick a preset or set a custom W × H. The layout adapts
                automatically.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Select value={preset} onValueChange={onPresetChange}>
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                  <SelectItem value={CUSTOM}>Custom…</SelectItem>
                </SelectContent>
              </Select>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1">
                  <Label className="text-xs">Width (mm)</Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={MIN_DIM_FLOOR_MM}
                    max={500}
                    value={widthMm}
                    disabled={!isCustom}
                    onChange={(e) => setWidthMm(Number(e.target.value) || 0)}
                    className="h-8"
                  />
                </div>
                <div className="grid gap-1">
                  <Label className="text-xs">Height (mm)</Label>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={MIN_DIM_FLOOR_MM}
                    max={500}
                    value={heightMm}
                    disabled={!isCustom}
                    onChange={(e) => setHeightMm(Number(e.target.value) || 0)}
                    className="h-8"
                  />
                </div>
              </div>
              {sizeError && (
                <div className="flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  {sizeError}
                </div>
              )}

              <Separator className="my-1" />

              <div className="grid gap-2">
                <Label className="text-xs">Orientation</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant={orientation === "portrait" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setOrientation("portrait")}
                    className="flex-1"
                  >
                    Portrait
                  </Button>
                  <Button
                    type="button"
                    variant={orientation === "landscape" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setOrientation("landscape")}
                    className="flex-1"
                  >
                    Landscape
                  </Button>
                </div>
              </div>

              <div className="grid gap-2">
                <Label className="text-xs">Text size</Label>
                <Select value={fontScaleId} onValueChange={setFontScaleId}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FONT_SCALES.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label className="text-xs">Output mode</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant={outputMode === "thermal" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setOutputMode("thermal")}
                    className="flex-1"
                  >
                    One per page
                  </Button>
                  <Button
                    type="button"
                    variant={outputMode === "a4_tile" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setOutputMode("a4_tile")}
                    className="flex-1"
                  >
                    Tile onto A4
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="flex-1 min-h-0">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <QrCode className="h-3.5 w-3.5" />
                Live preview
              </CardTitle>
              <CardDescription className="text-xs">
                Same layout the PDF will use. QR shown as placeholder —
                the real one comes from the transfer's attached image.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-auto">
              <div
                className="rounded-md bg-muted/30 p-4 flex items-center justify-center"
                style={{ minHeight: "120px" }}
              >
                <div
                  style={{
                    transform: `scale(${previewScale})`,
                    transformOrigin: "center center",
                  }}
                >
                  <PreviewLabel
                    widthMm={effWidthMm}
                    heightMm={effHeightMm}
                    fontScale={fontScale}
                    qrUrl={previewQrUrl}
                  />
                </div>
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">
                {Math.round(effWidthMm)} × {Math.round(effHeightMm)} mm ·
                {" "}
                {orientation === "landscape" ? "landscape" : "portrait"} ·
                {" "}
                {outputMode === "thermal" ? "1 label per page" : "A4 tile"}
              </div>
            </CardContent>
          </Card>

          <div className="space-y-2">
            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}
            {lastResult && !error && (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Generated {lastResult.label_count} label
                {lastResult.label_count !== 1 ? "s" : ""}
                {lastResult.skipped_count > 0
                  ? ` · ${lastResult.skipped_count} skipped (no QR)`
                  : ""}
                .
              </div>
            )}
            <Button
              className="w-full gap-2"
              size="lg"
              disabled={busy || selectableSelectedCount === 0 || !!sizeError}
              onClick={generate}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Printer className="h-4 w-4" />
              )}
              Generate PDF ({selectableSelectedCount})
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
