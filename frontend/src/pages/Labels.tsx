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
import { PageHeader } from "@/components/PageHeader";
import { HEADER_PILL, HeaderIconButton } from "@/components/header-controls";
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
  FIELD_KEYS,
  FIELD_LABELS,
  type FieldKey,
  type LayoutOverrides,
  type Orientation,
  type OutputMode,
  type PerPage,
  type SubmittedTransferRow,
} from "@/lib/labels-api";
import { fetchTransferItems, type TransferItem } from "@/lib/store-keeper-api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { planLabel, MIN_DIM_FLOOR_MM } from "@/lib/label-tiers";
import { cn } from "@/lib/utils";

const ALL_FARMS = "__all__";
const CUSTOM = "__custom__";

// Preset sizes — width × height in mm. Ordered roughly by use frequency.
const PRESETS = [
  { id: "100x50", label: "100 × 50 mm (standard)", w: 100, h: 50 },
  { id: "60x45",  label: "60 × 45 mm (ZQ520)",     w: 60,  h: 45 },
  { id: "50x25",  label: "50 × 25 mm (small)",     w: 50,  h: 25 },
  { id: "102x152", label: "102 × 152 mm (4×6 thermal)", w: 102, h: 152 },
  { id: "40x30",  label: "40 × 30 mm (bunch tag)",  w: 40,  h: 30 },
  { id: "70x40",  label: "70 × 40 mm",              w: 70,  h: 40 },
  // A4 — for office printers / proofing. Combine with the "Tile onto
  // A4" output mode to pack many labels onto one sheet.
  { id: "a4",     label: "210 × 297 mm (A4 sheet)", w: 210, h: 297 },
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
  target: "Kapkolia CSU Phase 1",
  scheduled: "31 May 2026 09:00",
  spray_type: "Full",
  greenhouse: "Kapkolia GH 04",
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
  overrides,
}: {
  widthMm: number;
  heightMm: number;
  fontScale: number;
  qrUrl?: string;
  overrides?: LayoutOverrides;
}) {
  const rawPlan = useMemo(() => planLabel(widthMm, heightMm), [widthMm, heightMm]);
  // Apply the user's font multiplier on top of the tier defaults, then
  // any explicit per-field overrides — same order as generate_pdf on the
  // server, so what's drawn here equals what wkhtmltopdf draws.
  const plan = useMemo(() => {
    const s = Math.max(0.5, Math.min(1.6, fontScale));
    const ov = overrides ?? {};
    return {
      ...rawPlan,
      basePt: ov.basePt ?? Math.round(rawPlan.basePt * s * 100) / 100,
      headPt: ov.headPt ?? Math.round(rawPlan.headPt * s * 100) / 100,
      qrSideMm: ov.qrSideMm ?? rawPlan.qrSideMm,
      paddingTopMm: ov.paddingTopMm ?? rawPlan.paddingTopMm,
      paddingRightMm: ov.paddingRightMm ?? rawPlan.paddingRightMm,
      paddingBottomMm: ov.paddingBottomMm ?? rawPlan.paddingBottomMm,
      paddingLeftMm: ov.paddingLeftMm ?? rawPlan.paddingLeftMm,
      orientation: ov.layoutMode ?? rawPlan.orientation,
      fields: ov.fields ?? rawPlan.fields,
    };
  }, [rawPlan, fontScale, overrides]);

  const isXs = plan.fields.length === 0;

  // The preview renders at real-world mm via inline styles. The parent
  // Card scales the whole block to fit the available width by setting a
  // CSS zoom on the wrapper.
  const baseStyle = {
    width: `${widthMm}mm`,
    height: `${heightMm}mm`,
    boxSizing: "border-box" as const,
    padding: `${plan.paddingTopMm}mm ${plan.paddingRightMm}mm ${plan.paddingBottomMm}mm ${plan.paddingLeftMm}mm`,
    fontSize: `${plan.basePt}pt`,
    border: "1px solid var(--border)",
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

  const showGh = plan.fields.includes("gh");
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
        {showGh && (
          <div style={{ fontWeight: 700, fontSize: `${plan.headPt}pt`, lineHeight: 1.1 }}>
            {SAMPLE.greenhouse}
          </div>
        )}
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
  const [perPage, setPerPage] = useState<PerPage>(2);
  const [fontScaleId, setFontScaleId] = useState<string>(DEFAULT_FONT_SCALE.id);
  // Legacy 4×6 is the Zebra-verified path — fixed 102×152mm sheet,
  // N labels stacked. When it's on, the dynamic W×H / orientation /
  // tier controls are inert; the backend ignores them.
  const isLegacy = outputMode === "legacy_4x6";
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

  // Manual layout overrides. Each value, when non-null, replaces the
  // tier default on both the preview and the server. Resetting back to
  // tier defaults is one click — see resetOverrides() below.
  const tierDefaults = useMemo(
    () => planLabel(effWidthMm, effHeightMm),
    [effWidthMm, effHeightMm],
  );
  const [padT, setPadT] = useState<number | "">("");
  const [padR, setPadR] = useState<number | "">("");
  const [padB, setPadB] = useState<number | "">("");
  const [padL, setPadL] = useState<number | "">("");
  const [qrSide, setQrSide] = useState<number | "">("");
  const [basePtIn, setBasePtIn] = useState<number | "">("");
  const [headPtIn, setHeadPtIn] = useState<number | "">("");
  // "" = use tier's auto decision (row/stack based on aspect ratio).
  const [layoutMode, setLayoutMode] = useState<"" | "row" | "stack">("");
  // null = tier default fields; Set = manual selection (empty Set = QR only).
  const [fieldsSel, setFieldsSel] = useState<Set<FieldKey> | null>(null);

  const overrides: LayoutOverrides = {
    paddingTopMm:    padT === "" ? undefined : padT,
    paddingRightMm:  padR === "" ? undefined : padR,
    paddingBottomMm: padB === "" ? undefined : padB,
    paddingLeftMm:   padL === "" ? undefined : padL,
    qrSideMm:        qrSide === "" ? undefined : qrSide,
    basePt:          basePtIn === "" ? undefined : basePtIn,
    headPt:          headPtIn === "" ? undefined : headPtIn,
    layoutMode:      layoutMode === "" ? undefined : layoutMode,
    fields:          fieldsSel === null ? undefined : Array.from(fieldsSel),
  };

  const resetOverrides = () => {
    setPadT(""); setPadR(""); setPadB(""); setPadL("");
    setQrSide(""); setBasePtIn(""); setHeadPtIn("");
    setLayoutMode(""); setFieldsSel(null);
  };

  const toggleField = (k: FieldKey) => {
    setFieldsSel((prev) => {
      // Seed from tier defaults the first time the operator clicks a field.
      const base = prev ?? new Set<FieldKey>(tierDefaults.fields as FieldKey[]);
      const next = new Set(base);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<{
    label_count: number;
    skipped_count: number;
  } | null>(null);

  // Chemicals modal — opened by clicking a transfer's SE name.
  const [detailSe, setDetailSe] = useState<string | null>(null);
  const [detailItems, setDetailItems] = useState<TransferItem[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const openDetail = (name: string) => {
    setDetailSe(name);
    setDetailItems([]);
    setDetailLoading(true);
    fetchTransferItems(name)
      .then(setDetailItems)
      .catch(() => setDetailItems([]))
      .finally(() => setDetailLoading(false));
  };

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
    // Legacy mode hard-codes 102×152mm on the backend, so the W/H
    // inputs are irrelevant — skip validation that would otherwise
    // block Generate if the operator typed a too-small custom size.
    if (isLegacy) return null;
    if (widthMm < MIN_DIM_FLOOR_MM || heightMm < MIN_DIM_FLOOR_MM) {
      return `Width and height must each be at least ${MIN_DIM_FLOOR_MM}mm.`;
    }
    if (widthMm > 500 || heightMm > 500) {
      return "Width and height must each be 500mm or less.";
    }
    return null;
  }, [widthMm, heightMm, isLegacy]);

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
        perPage,
        overrides,
      });
      setLastResult({
        label_count: resp.label_count,
        skipped_count: (resp.skipped || []).length,
      });
      if (resp.data && resp.filename) {
        downloadBase64Pdf(resp.data, resp.filename);
        // Reload so the freshly-stamped "Printed" badges show up.
        load();
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
      <PageHeader
        title="Labels"
        eyebrow={
          <>
            Print QR labels for submitted spray-plan transfers. Pick any
            size — the layout adapts.
          </>
        }
      >
        <Select value={farm} onValueChange={setFarm}>
          <SelectTrigger aria-label="Farm" className={HEADER_PILL}>
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
        <DatePicker value={fromDate} onChange={setFromDate} />
        <DatePicker value={toDate} onChange={setToDate} />
        <HeaderIconButton onClick={load} disabled={loading} title="Refresh">
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </HeaderIconButton>
      </PageHeader>

      <div className="grid flex-1 grid-cols-1 lg:grid-cols-3 gap-4 p-4 md:p-6 lg:items-start">
        {/* ── Left: selection tree ─────────────────────────────── */}
        <Card className="lg:col-span-2 flex flex-col min-h-0">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-sm">Transfers</CardTitle>
              <div className="text-xs text-muted-foreground tabular-nums">
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
                              <button
                                type="button"
                                className="font-mono text-xs flex-1 text-left hover:underline hover:text-primary"
                                title="View chemicals on this transfer"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  openDetail(r.name);
                                }}
                              >
                                {r.name}
                              </button>
                              {r.spray_type && (
                                <Badge variant="outline" className="text-[10px]">
                                  {r.spray_type}
                                </Badge>
                              )}
                              <Badge variant="secondary" className="text-[10px]">
                                {r.qr_count} QR
                              </Badge>
                              {r.labels_printed && (
                                <Badge
                                  className="bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/15 text-[10px] gap-1"
                                  title={
                                    `Printed${r.labels_print_count > 1 ? ` ${r.labels_print_count}×` : ""}` +
                                    (r.labels_printed_on ? ` · ${r.labels_printed_on.slice(0, 16)}` : "") +
                                    (r.labels_printed_by ? ` · ${r.labels_printed_by}` : "")
                                  }
                                >
                                  <CheckCircle2 className="h-3 w-3" />
                                  Printed
                                  {r.labels_print_count > 1 ? ` ×${r.labels_print_count}` : ""}
                                </Badge>
                              )}
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
        <div className="flex flex-col gap-4 lg:sticky lg:top-6 lg:max-h-[calc(100svh-3rem)] lg:overflow-y-auto">
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
                  <Button
                    type="button"
                    variant={outputMode === "legacy_4x6" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setOutputMode("legacy_4x6")}
                    className="flex-1"
                    title="Fixed 4&quot;×6&quot; (102×152mm) portrait sheet with N labels stacked — the format the Zebra ZQ520 prints cleanly."
                  >
                    4×6 (Zebra)
                  </Button>
                </div>
              </div>

              {isLegacy && (
                <div className="grid gap-2">
                  <Label className="text-xs">Labels per page</Label>
                  <Select
                    value={String(perPage)}
                    onValueChange={(v) => setPerPage(Number(v) as PerPage)}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1 label (4" × 6")</SelectItem>
                      <SelectItem value="2">2 labels (4" × 3" each)</SelectItem>
                      <SelectItem value="3">3 labels (4" × 2" each)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    Fixed 102 × 152 mm portrait sheet. Width / height /
                    orientation above are ignored in this mode.
                  </p>
                </div>
              )}

              {!isLegacy && (
                <>
                  <Separator className="my-1" />
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Manual layout</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={resetOverrides}
                      className="h-6 text-[11px]"
                    >
                      Reset to tier
                    </Button>
                  </div>
                  <div className="text-[10px] text-muted-foreground -mt-1">
                    Empty = tier default. Preview mirrors the PDF exactly.
                  </div>

                  <div className="grid gap-1.5">
                    <Label className="text-[10px]">QR placement</Label>
                    <Select
                      value={layoutMode === "" ? "auto" : layoutMode}
                      onValueChange={(v) =>
                        setLayoutMode(v === "auto" ? "" : (v as "row" | "stack"))
                      }
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">
                          Auto ({tierDefaults.orientation === "row" ? "side" : "center"})
                        </SelectItem>
                        <SelectItem value="row">QR on the side</SelectItem>
                        <SelectItem value="stack">QR centered on top</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[10px]">Fields shown</Label>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => setFieldsSel(new Set<FieldKey>(FIELD_KEYS))}
                          className="text-[10px] text-muted-foreground hover:text-foreground"
                        >
                          all
                        </button>
                        <span className="text-[10px] text-muted-foreground">·</span>
                        <button
                          type="button"
                          onClick={() => setFieldsSel(new Set<FieldKey>())}
                          className="text-[10px] text-muted-foreground hover:text-foreground"
                        >
                          QR only
                        </button>
                        <span className="text-[10px] text-muted-foreground">·</span>
                        <button
                          type="button"
                          onClick={() => setFieldsSel(null)}
                          className="text-[10px] text-muted-foreground hover:text-foreground"
                        >
                          tier
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                      {FIELD_KEYS.map((k) => {
                        const effective = fieldsSel ?? new Set<FieldKey>(tierDefaults.fields as FieldKey[]);
                        const checked = effective.has(k);
                        return (
                          <label
                            key={k}
                            className="flex items-center gap-1.5 text-[11px] cursor-pointer"
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={() => toggleField(k)}
                              className="h-3.5 w-3.5"
                            />
                            {FIELD_LABELS[k]}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {[
                      { lbl: "Pad ↑", val: padT, set: setPadT, def: tierDefaults.paddingTopMm },
                      { lbl: "Pad →", val: padR, set: setPadR, def: tierDefaults.paddingRightMm },
                      { lbl: "Pad ↓", val: padB, set: setPadB, def: tierDefaults.paddingBottomMm },
                      { lbl: "Pad ←", val: padL, set: setPadL, def: tierDefaults.paddingLeftMm },
                    ].map((f) => (
                      <div key={f.lbl} className="grid gap-0.5">
                        <Label className="text-[10px]">{f.lbl} mm</Label>
                        <Input
                          type="number"
                          inputMode="decimal"
                          step="0.1"
                          min={0}
                          max={50}
                          value={f.val}
                          placeholder={String(f.def)}
                          onChange={(e) =>
                            f.set(e.target.value === "" ? "" : Number(e.target.value))
                          }
                          className="h-7 px-2 text-xs"
                        />
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    <div className="grid gap-0.5">
                      <Label className="text-[10px]">QR mm</Label>
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="0.5"
                        min={5}
                        max={500}
                        value={qrSide}
                        placeholder={String(tierDefaults.qrSideMm)}
                        onChange={(e) =>
                          setQrSide(e.target.value === "" ? "" : Number(e.target.value))
                        }
                        className="h-7 px-2 text-xs"
                      />
                    </div>
                    <div className="grid gap-0.5">
                      <Label className="text-[10px]">Base pt</Label>
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="0.5"
                        min={4}
                        max={48}
                        value={basePtIn}
                        placeholder={String(tierDefaults.basePt)}
                        onChange={(e) =>
                          setBasePtIn(e.target.value === "" ? "" : Number(e.target.value))
                        }
                        className="h-7 px-2 text-xs"
                      />
                    </div>
                    <div className="grid gap-0.5">
                      <Label className="text-[10px]">Head pt</Label>
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="0.5"
                        min={4}
                        max={48}
                        value={headPtIn}
                        placeholder={String(tierDefaults.headPt)}
                        onChange={(e) =>
                          setHeadPtIn(e.target.value === "" ? "" : Number(e.target.value))
                        }
                        className="h-7 px-2 text-xs"
                      />
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
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
                    overrides={overrides}
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

      <Dialog
        open={!!detailSe}
        onOpenChange={(o) => {
          if (!o) setDetailSe(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{detailSe}</DialogTitle>
            <DialogDescription>
              {detailLoading
                ? "Loading chemicals…"
                : `${detailItems.length} chemical${detailItems.length !== 1 ? "s" : ""} on this transfer`}
            </DialogDescription>
          </DialogHeader>
          {detailLoading ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : detailItems.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No chemicals found on this transfer.
            </div>
          ) : (
            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Chemical</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead>UoM</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detailItems.map((it, i) => (
                    <TableRow key={`${it.item_code}-${i}`}>
                      <TableCell className="text-xs">
                        <div className="font-medium">
                          {it.item_name || it.item_code}
                        </div>
                        <div className="text-muted-foreground font-mono text-[0.65rem]">
                          {it.item_code}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs font-semibold">
                        {it.qty}
                      </TableCell>
                      <TableCell className="text-xs">{it.uom}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
