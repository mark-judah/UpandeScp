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
  total_qty: number;
  item_count: number;
  qr_count: number;
  has_qr: boolean;
  /** First QR attachment URL — used by the live preview so the
   *  operator sees the real code, not a placeholder. */
  qr_image_url: string;
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
    "upande_scp.serverscripts.store_keeper_api.list_submitted_transfers",
    opts,
  );
  return unwrap<SubmittedTransfersResp>(r);
}

export type OutputMode = "thermal" | "a4_tile";
export type Orientation = "portrait" | "landscape";

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

export async function generateLabelPdf(opts: {
  seNames: string[];
  widthMm: number;
  heightMm: number;
  outputMode: OutputMode;
  orientation: Orientation;
  fontScale: number;
}): Promise<GeneratePdfResp> {
  const r = await call(
    "upande_scp.serverscripts.spray_plan_labels.generate_pdf",
    {
      se_names: JSON.stringify(opts.seNames),
      width_mm: opts.widthMm,
      height_mm: opts.heightMm,
      output_mode: opts.outputMode,
      orientation: opts.orientation,
      font_scale: opts.fontScale,
    },
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
