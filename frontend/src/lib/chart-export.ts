/**
 * Dependency-free chart export helpers.
 *
 *  - ``exportChartAsPng``  serialises the recharts SVG inside the given
 *    container into a high-resolution PNG and triggers a download.
 *  - ``printChartAsPdf``   mounts a hidden iframe with the SVG on a
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

export type LegendItem = { label: string; color: string };

export type ChartExportOptions = {
  /** Title drawn at the top of the PNG (e.g. "Thrips Adults"). */
  title?: string;
  /** Small badge drawn next to the title (e.g. "Pest", "Disease"). */
  badge?: string;
  /** Legend rendered as a column on the right of the PNG. */
  legend?: LegendItem[];
};

/** Download the chart inside ``container`` as a PNG file. When ``opts``
 *  include a title/badge/legend the canvas is enlarged and those elements
 *  are painted directly so the exported image is self-explanatory. */
export async function exportChartAsPng(
  container: HTMLElement,
  filename: string,
  opts: ChartExportOptions = {},
): Promise<void> {
  const svg = findChartSvg(container);
  if (!svg) throw new Error("No chart SVG found inside container.");

  const chartW = svg.clientWidth || svg.viewBox.baseVal.width || 800;
  const chartH = svg.clientHeight || svg.viewBox.baseVal.height || 400;

  const inlined = inlineSvgStyles(svg);
  inlined.setAttribute("width", String(chartW));
  inlined.setAttribute("height", String(chartH));
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

  // Layout in CSS pixels — scaled up by PNG_SCALE when committed to canvas.
  const hasTitle = !!opts.title;
  const headerH = hasTitle ? 56 : 0;
  const legendItems = opts.legend || [];
  const legendW = legendItems.length ? 180 : 0;
  const pad = 16;
  const totalW = chartW + legendW + (legendW ? pad : 0);
  const totalH = chartH + headerH;

  const canvas = document.createElement("canvas");
  canvas.width = totalW * PNG_SCALE;
  canvas.height = totalH * PNG_SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    URL.revokeObjectURL(url);
    throw new Error("Canvas 2D context unavailable.");
  }
  ctx.scale(PNG_SCALE, PNG_SCALE);
  // White paint underneath so the PNG isn't transparent.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, totalW, totalH);

  if (hasTitle) {
    ctx.fillStyle = "#0f172a";
    ctx.font =
      "600 18px Inter, system-ui, -apple-system, Segoe UI, Arial, sans-serif";
    ctx.textBaseline = "top";
    const titleX = 8;
    const titleY = 14;
    ctx.fillText(opts.title!, titleX, titleY);
    if (opts.badge) {
      const titleW = ctx.measureText(opts.title!).width;
      ctx.font =
        "500 11px Inter, system-ui, -apple-system, Segoe UI, Arial, sans-serif";
      const badgeText = opts.badge;
      const tw = ctx.measureText(badgeText).width;
      const bx = titleX + titleW + 10;
      const by = titleY + 2;
      const bw = tw + 12;
      const bh = 18;
      ctx.fillStyle = "#e2e8f0";
      const r = 9;
      ctx.beginPath();
      ctx.moveTo(bx + r, by);
      ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
      ctx.arcTo(bx + bw, by + bh, bx, by + bh, r);
      ctx.arcTo(bx, by + bh, bx, by, r);
      ctx.arcTo(bx, by, bx + bw, by, r);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#334155";
      ctx.textBaseline = "middle";
      ctx.fillText(badgeText, bx + 6, by + bh / 2);
      ctx.textBaseline = "top";
    }
  }

  ctx.drawImage(img, 0, headerH, chartW, chartH);
  URL.revokeObjectURL(url);

  if (legendItems.length) {
    const lx = chartW + pad;
    let ly = headerH + 8;
    ctx.font =
      "500 12px Inter, system-ui, -apple-system, Segoe UI, Arial, sans-serif";
    ctx.textBaseline = "middle";
    for (const item of legendItems) {
      ctx.fillStyle = resolveCssColor(item.color, container);
      ctx.beginPath();
      ctx.arc(lx + 5, ly + 7, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#475569";
      const maxLabelW = legendW - 18;
      const label = ellipsize(ctx, item.label, maxLabelW);
      ctx.fillText(label, lx + 14, ly + 7);
      ly += 18;
    }
    ctx.textBaseline = "top";
  }

  const pngBlob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png",
    ),
  );
  triggerDownload(pngBlob, filename.endsWith(".png") ? filename : `${filename}.png`);
}

/** Resolve a CSS color string (including ``var(--foo)``) to a concrete
 *  rgb/hex value that the canvas paint loop will accept. */
function resolveCssColor(color: string, ctx: HTMLElement): string {
  if (!color.startsWith("var(")) return color;
  const match = color.match(/var\(([^),]+)\)/);
  if (!match) return color;
  const name = match[1].trim();
  const resolved = getComputedStyle(ctx).getPropertyValue(name).trim();
  return resolved || "#64748b";
}

function ellipsize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

/** Render the chart on a print-friendly page inside a hidden iframe and
 *  trigger the browser's print dialog so the operator can pick "Save as
 *  PDF". Uses an iframe instead of a popup window because modern browsers
 *  return ``null`` from ``window.open`` when the ``noopener`` feature is
 *  set, which left the popup tab blank. */
export function printChartAsPdf(
  container: HTMLElement,
  title: string,
  opts: { badge?: string; legend?: LegendItem[] } = {},
): void {
  const svg = findChartSvg(container);
  if (!svg) return;
  const inlined = inlineSvgStyles(svg);
  const w = svg.clientWidth || svg.viewBox.baseVal.width || 800;
  const h = svg.clientHeight || svg.viewBox.baseVal.height || 400;
  inlined.setAttribute("width", String(w));
  inlined.setAttribute("height", String(h));

  const esc = (s: string) =>
    s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const safeTitle = esc(title);
  const badgeHtml = opts.badge
    ? `<span class="badge">${esc(opts.badge)}</span>`
    : "";
  const legendItems = (opts.legend || []).map((it) => {
    const color = resolveCssColor(it.color, container);
    return `<li><span class="swatch" style="background:${esc(color)}"></span><span>${esc(it.label)}</span></li>`;
  });
  const legendHtml = legendItems.length
    ? `<aside class="legend"><ul>${legendItems.join("")}</ul></aside>`
    : "";

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <style>
    @page { margin: 18mm; }
    body { font: 13px Inter, Arial, sans-serif; color: #1f2937; margin: 0; padding: 16px; }
    h1 { font-size: 18px; margin: 0; display: inline-block; }
    .badge { display: inline-block; background: #e2e8f0; color: #334155; font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 9999px; margin-left: 8px; vertical-align: middle; }
    .meta { font-size: 11px; color: #6b7280; margin: 4px 0 16px 0; }
    .layout { display: flex; gap: 16px; align-items: stretch; }
    .chart { flex: 1; min-width: 0; }
    .chart svg { width: 100%; height: auto; }
    .legend { width: 180px; flex-shrink: 0; border-left: 1px solid #e5e7eb; padding-left: 12px; }
    .legend ul { list-style: none; margin: 0; padding: 0; }
    .legend li { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #475569; padding: 3px 0; }
    .swatch { width: 8px; height: 8px; border-radius: 9999px; flex-shrink: 0; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <div><h1>${safeTitle}</h1>${badgeHtml}</div>
  <div class="meta">Exported ${new Date().toLocaleString()}</div>
  <div class="layout">
    <div class="chart">${svgString(inlined)}</div>
    ${legendHtml}
  </div>
</body>
</html>`;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.style.opacity = "0";
  document.body.appendChild(iframe);

  let printed = false;
  const cleanup = () => {
    // Delay removal until after the print dialog interaction settles —
    // tearing the iframe down mid-print can abort the job in some browsers.
    setTimeout(() => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }, 1000);
  };
  const triggerPrint = () => {
    if (printed) return;
    printed = true;
    const cw = iframe.contentWindow;
    if (!cw) {
      cleanup();
      return;
    }
    try {
      cw.focus();
      cw.print();
    } catch (e) {
      console.error("[chart-export] PDF print failed", e);
    } finally {
      cleanup();
    }
  };

  iframe.onload = triggerPrint;
  const idoc = iframe.contentDocument || iframe.contentWindow?.document;
  if (idoc) {
    idoc.open();
    idoc.write(html);
    idoc.close();
  }
  // Fallback for browsers that don't fire `load` after document.write —
  // ensures the print dialog still appears once the SVG has had a moment
  // to lay out.
  setTimeout(triggerPrint, 400);
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
