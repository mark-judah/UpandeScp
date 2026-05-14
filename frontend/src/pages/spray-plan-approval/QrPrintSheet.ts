import { escapeHtml } from "./utils"
import type { QrLabel } from "./types"

export function openQrPrintWindow(labels: QrLabel[]): void {
  if (!labels.length) return
  const win = window.open("", "_blank", "width=560,height=740")
  if (!win) {
    window.alert("Pop-ups are blocked. Allow pop-ups for this site to print labels.")
    return
  }

  const today = new Date().toLocaleDateString("en-GB")

  const rows = labels
    .map((lbl) => {
      const farmGh = [lbl.farm, lbl.greenhouse]
        .filter(Boolean)
        .map(escapeHtml)
        .join(" · ")
      const tgt = escapeHtml(lbl.tgt_wh || lbl.src_wh || "—")
      const qty = escapeHtml(`${lbl.qty} ${lbl.uom || ""}`)
      return (
        `<div class="label">` +
        `<img class="qrimg" src="data:image/png;base64,${lbl.png_base64}">` +
        `<div class="chem">${escapeHtml(lbl.chemical)}</div>` +
        (farmGh ? `<div class="row">${farmGh}</div>` : "") +
        `<div class="row"><span class="k">QTY</span><span class="v">${qty}</span></div>` +
        `<div class="row"><span class="k">TGT</span><span class="v">${tgt}</span></div>` +
        `<div class="row foot">${escapeHtml(lbl.wo || "")} · ${today}</div>` +
        `</div>`
      )
    })
    .join("")

  win.document.write(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Chemical QR Labels</title><style>` +
      `@page{size:30mm 40mm;margin:0}` +
      `*{box-sizing:border-box;margin:0;padding:0}` +
      `body{font-family:Arial,Helvetica,sans-serif;background:#e5e7eb;padding:16px}` +
      `.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:14px;padding:10px 14px;background:#1f2937;border-radius:6px;color:#fff}` +
      `.toolbar h2{flex:1;font-size:.85rem;font-weight:700}` +
      `.toolbar button{padding:6px 14px;border:none;border-radius:5px;font-weight:600;font-size:.72rem;cursor:pointer}` +
      `.btn-print{background:#059669;color:#fff}.btn-close{background:#374151;color:#fff}` +
      `.sheet{display:flex;flex-direction:column;align-items:center;gap:6px}` +
      `.label{width:30mm;height:40mm;padding:1mm;background:#fff;border:1px solid #000;` +
      `display:flex;flex-direction:column;align-items:center;overflow:hidden;page-break-after:always}` +
      `.label:last-child{page-break-after:auto}` +
      `.qrimg{width:20mm;height:20mm;image-rendering:pixelated;display:block}` +
      `.chem{font-size:6pt;font-weight:700;text-align:center;line-height:1.1;margin-top:0.8mm;` +
      `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:28mm}` +
      `.row{font-size:5pt;line-height:1.2;width:100%;display:flex;justify-content:space-between;` +
      `gap:1mm;margin-top:0.4mm;white-space:nowrap;overflow:hidden}` +
      `.row .k{font-weight:700;color:#555;flex:0 0 auto}` +
      `.row .v{font-weight:600;text-align:right;overflow:hidden;text-overflow:ellipsis}` +
      `.row.foot{justify-content:center;color:#444;font-size:4.5pt;margin-top:auto}` +
      `@media print{body{background:#fff;padding:0}.no-print{display:none!important}` +
      `.sheet{gap:0}.label{border:none}}` +
      `</style></head><body>` +
      `<div class="toolbar no-print"><h2>Chemical QR Labels — 30×40 mm (${labels.length}` +
      ` label${labels.length !== 1 ? "s" : ""})</h2>` +
      `<button class="btn-print" onclick="window.print()">Print</button>` +
      `<button class="btn-close" onclick="window.close()">Close</button></div>` +
      `<div class="sheet">${rows}</div></body></html>`,
  )
  win.document.close()
}
