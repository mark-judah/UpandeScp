/**
 * Dependency-free chart export helpers.
 *
 *  - ``exportChartAsPng``  serialises the recharts SVG inside the given
 *    container into a high-resolution PNG and triggers a download.
 *  - ``printChartAsPdf``   opens a new tab with the SVG inlined onto a
 *    print-friendly page and auto-triggers the browser's print dialog.
 *    Operators choose "Save as PDF" from the destination dropdown — every
 *    modern browser ships this without us bundling jsPDF.
 *
 * Both helpers walk the container for the first ``<svg>`` recharts has
 * rendered. They inline computed styles so the export matches what the
 * operator sees on screen (recharts paints text/strokes via CSS classes
 * that wouldn't otherwise survive the SVG → image trip).
 */

const PNG_SCALE = 2; // 2× = retina-sharp; 3× costs memory without much gain

/** Clone an SVG node and inline the computed styles needed for fidelity
 *  (font, fill, stroke, opacity). Recharts uses className-based styling
 *  that's lost the moment the SVG leaves the document. */
function inlineSvgStyles(srcSvg: SVGSVGElement): SVGSVGElement {
  const clone = srcSvg.cloneNode(true) as SVGSVGElement;
  const sources = srcSvg.querySelectorAll<SVGElement>("*");
  const targets = clone.querySelectorAll<SVGElement>("*");
  const props = [
    "fill",
    "stroke",
    "stroke-width",
    "stroke-dasharray",
    "stroke-opacity",
    "fill-opacity",
    "opacity",
    "font-family",
    "font-size",
    "font-weight",
    "letter-spacing",
    "text-anchor",
  ];
  sources.forEach((src, i) => {
    const dst = targets[i] as SVGElement | undefined;
    if (!dst) return;
    const cs = window.getComputedStyle(src);
    const tokens: string[] = [];
    props.forEach((p) => {
      const v = cs.getPropertyValue(p);
      if (v && v !== "normal" && v !== "none none none none") {
        tokens.push(`${p}:${v}`);
      }
    });
    // Preserve any inline style the source already had.
    const existing = dst.getAttribute("style") || "";
    dst.setAttribute("style", `${existing};${tokens.join(";")}`);
  });
  // White background so PNG/PDF doesn't render dark on dark mode browsers.
  const bg = clone.ownerDocument!.createElementNS(
    "http://www.w3.org/2000/svg",
    "rect",
  );
  bg.setAttribute("width", "100%");
  bg.setAttribute("height", "100%");
  bg.setAttribute("fill", "#ffffff");
  clone.insertBefore(bg, clone.firstChild);
  return clone;
}

function svgString(svg: SVGSVGElement): string {
  const xml = new XMLSerializer().serializeToString(svg);
  // Make sure the namespace is present even if the source omitted it.
  return xml.includes("xmlns=")
    ? xml
    : xml.replace(/^<svg/, `<svg xmlns="http://www.w3.org/2000/svg"`);
}

function findChartSvg(container: HTMLElement): SVGSVGElement | null {
  // recharts wraps the chart in a .recharts-wrapper / .recharts-surface,
  // both of which are <div>/<svg>. The first matching <svg> is the one
  // we want; the legend hover-row dots aren't SVGs.
  const svg = container.querySelector<SVGSVGElement>(
    ".recharts-wrapper svg, svg.recharts-surface, svg",
  );
  return svg && svg.tagName.toLowerCase() === "svg" ? svg : null;
}

/** Download the chart inside ``container`` as a PNG file. */
export async function exportChartAsPng(
  container: HTMLElement,
  filename: string,
): Promise<void> {
  const svg = findChartSvg(container);
  if (!svg) throw new Error("No chart SVG found inside container.");

  const w = svg.clientWidth || svg.viewBox.baseVal.width || 800;
  const h = svg.clientHeight || svg.viewBox.baseVal.height || 400;

  const inlined = inlineSvgStyles(svg);
  inlined.setAttribute("width", String(w));
  inlined.setAttribute("height", String(h));
  const svgBlob = new Blob([svgString(inlined)], {
    type: "image/svg+xml;charset=utf-8",
  });
  const url = URL.createObjectURL(svgBlob);

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () =>
      reject(new Error("Failed to rasterise chart SVG."));
    img.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = w * PNG_SCALE;
  canvas.height = h * PNG_SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    URL.revokeObjectURL(url);
    throw new Error("Canvas 2D context unavailable.");
  }
  // White paint underneath so the PNG isn't transparent — matters when
  // the operator drops it into a printed report or a slide deck.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);

  const pngBlob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png",
    ),
  );
  triggerDownload(pngBlob, filename.endsWith(".png") ? filename : `${filename}.png`);
}

/** Open a new tab with the chart inlined on a print-friendly page and
 *  auto-trigger ``window.print()`` so the operator can pick "Save as PDF".
 *  Returns the opened window so callers can add their own teardown if
 *  they need to. */
export function printChartAsPdf(
  container: HTMLElement,
  title: string,
): Window | null {
  const svg = findChartSvg(container);
  if (!svg) return null;
  const inlined = inlineSvgStyles(svg);
  const w = svg.clientWidth || svg.viewBox.baseVal.width || 800;
  const h = svg.clientHeight || svg.viewBox.baseVal.height || 400;
  inlined.setAttribute("width", String(w));
  inlined.setAttribute("height", String(h));

  const win = window.open("", "_blank", "noopener,noreferrer");
  if (!win) return null;
  const safeTitle = title.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  win.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <style>
    @page { margin: 18mm; }
    body { font: 13px Inter, Arial, sans-serif; color: #1f2937; margin: 0; padding: 16px; }
    h1 { font-size: 16px; margin: 0 0 4px 0; }
    .meta { font-size: 11px; color: #6b7280; margin-bottom: 16px; }
    .chart { width: 100%; max-width: 100%; }
    .chart svg { width: 100%; height: auto; }
    @media print {
      body { padding: 0; }
      .no-print { display: none !important; }
    }
    .actions { margin-top: 12px; }
    .actions button { font: 13px Inter, Arial, sans-serif; padding: 6px 12px; border: 1px solid #d1d5db; background: #fff; border-radius: 6px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>${safeTitle}</h1>
  <div class="meta">Exported ${new Date().toLocaleString()}</div>
  <div class="chart">${svgString(inlined)}</div>
  <div class="actions no-print">
    <button onclick="window.print()">Save as PDF</button>
  </div>
  <script>setTimeout(function(){ window.print(); }, 200);</script>
</body>
</html>`);
  win.document.close();
  return win;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Slugify an arbitrary title for use in a download filename. */
export function slugifyForFile(s: string): string {
  return (s || "chart")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
