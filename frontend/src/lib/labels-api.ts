/**
 * Client for the dynamic-size label printer.
 *
 * Two endpoints in play:
 *  - ``list_submitted_transfers`` — the selection-tree dataset
 *    (Material-Transfer SEs that have QR attachments and are
 *    docstatus=1, so they're ready to be printed).
 *  - ``generate_pdf`` (in ``spray_plan_labels``) — returns a base64
 *    PDF the caller saves to disk via a Blob URL.
 */
import { call } from "./frappe";

export interface SubmittedTransferRow {
  name: string;
  posting_date: string;
  work_order: string;
  from_warehouse: string;
  to_warehouse: string;
  farm: string;
  greenhouse: string;
  spray_type: string;
  /** Verification status of the underlying SE — "Verified" means the
   *  transfer was biometric-authorised; anything else means manual. */
  biometric_status: string;
  total_qty: number;
  item_count: number;
  qr_count: number;
  has_qr: boolean;
  /** First QR attachment URL — used by the live preview so the
   *  operator sees the real code, not a placeholder. */
  qr_image_url: string;
  /** Print tracking — set the first time labels for this SE are generated.
   *  Informational only; reprinting is always allowed and bumps the count. */
  labels_printed: boolean;
  labels_print_count: number;
  labels_printed_on: string;
  labels_printed_by: string;
}

export interface SubmittedTransfersResp {
  rows: SubmittedTransferRow[];
  farms: string[];
}

function unwrap<T>(resp: any): T {
  return (resp && resp.message !== undefined ? resp.message : resp) as T;
}

export async function fetchSubmittedTransfers(opts: {
  farm?: string;
  from_date?: string;
  to_date?: string;
} = {}): Promise<SubmittedTransfersResp> {
  const r = await call(
    "upande_scp.serverscripts.store.store_keeper_api.list_submitted_transfers",
    opts,
  );
  return unwrap<SubmittedTransfersResp>(r);
}

export type OutputMode = "thermal" | "a4_tile" | "legacy_4x6";
export type Orientation = "portrait" | "landscape";
/** Labels stacked on a 102×152mm (4"×6") portrait sheet — the legacy
 *  geometry the Stock Entry list-view client script has always used,
 *  and the only one verified to print cleanly on the Zebra ZQ520. */
export type PerPage = 1 | 2 | 3;

export interface SkippedLabel {
  se: string;
  reason: string;
}

export interface GeneratePdfResp {
  data: string | null;       // base64-encoded PDF
  filename: string | null;
  label_count: number;
  skipped: SkippedLabel[];
}

/** Operator-supplied overrides — when present, the backend applies them
 *  verbatim to the plan, replacing the tier defaults. Pass undefined for
 *  any field you want the tier to decide. */
export interface LayoutOverrides {
  paddingTopMm?: number;
  paddingRightMm?: number;
  paddingBottomMm?: number;
  paddingLeftMm?: number;
  qrSideMm?: number;
  basePt?: number;
  headPt?: number;
  /** "row" = QR on the side, "stack" = QR on top centered, undefined =
   *  let the tier's aspect-ratio rule decide. */
  layoutMode?: "row" | "stack";
  /** Subset of ["chem","qty","se","from","to","sched","type"]. Empty
   *  array means "QR only, no text". Undefined keeps the tier default. */
  fields?: string[];
}

export const FIELD_KEYS = [
  "se", "chem", "qty", "gh", "from", "to", "sched", "type",
] as const;
export type FieldKey = typeof FIELD_KEYS[number];
export const FIELD_LABELS: Record<FieldKey, string> = {
  se: "SE name",
  chem: "Chemical",
  qty: "Quantity",
  gh: "GH",
  from: "From",
  to: "To",
  sched: "Scheduled",
  type: "Spray type",
};

export async function generateLabelPdf(opts: {
  seNames: string[];
  widthMm: number;
  heightMm: number;
  outputMode: OutputMode;
  orientation: Orientation;
  fontScale: number;
  /** Only consulted when ``outputMode === "legacy_4x6"``. Backend
   *  routes the call through ``_render_legacy_html`` instead of the
   *  dynamic-size renderer when ``per_page`` is set. */
  perPage?: PerPage;
  overrides?: LayoutOverrides;
}): Promise<GeneratePdfResp> {
  const ov = opts.overrides ?? {};
  const args: Record<string, unknown> =
    opts.outputMode === "legacy_4x6"
      ? {
          se_names: JSON.stringify(opts.seNames),
          per_page: opts.perPage ?? 2,
        }
      : {
          se_names: JSON.stringify(opts.seNames),
          width_mm: opts.widthMm,
          height_mm: opts.heightMm,
          output_mode: opts.outputMode,
          orientation: opts.orientation,
          font_scale: opts.fontScale,
          padding_top_mm:    ov.paddingTopMm,
          padding_right_mm:  ov.paddingRightMm,
          padding_bottom_mm: ov.paddingBottomMm,
          padding_left_mm:   ov.paddingLeftMm,
          qr_side_mm:        ov.qrSideMm,
          base_pt:           ov.basePt,
          head_pt:           ov.headPt,
          layout_mode:       ov.layoutMode,
          // ``fields`` arrives as a list — JSON-encode so Frappe's form
          // parser doesn't collapse it to the last value or to a CSV.
          fields:            ov.fields ? JSON.stringify(ov.fields) : undefined,
        };
  const r = await call(
    "upande_scp.serverscripts.spray_plan_ops.spray_plan_labels.generate_pdf",
    args,
  );
  return unwrap<GeneratePdfResp>(r);
}

/** Decode a base64 PDF payload into a Blob URL and trigger download.
 *
 *  Returns the object URL so the caller can revoke it once the
 *  download dialog is dismissed.
 */
export function downloadBase64Pdf(b64: string, filename: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a beat to start the download before the URL
  // is revoked — otherwise some browsers cancel the in-flight save.
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  return url;
}
