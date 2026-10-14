/**
 * Visual findings ▸ the large viewer: one near-fullscreen dialog with a Photo
 * tab (zoom / pan to inspect an insect; the 1600 thumb first, the original once
 * zoomed past 2x) and a Location tab (the whole greenhouse, zoomable, with the
 * finding's bed and zone lit). The panel owns the open state and the ← / →
 * and Esc keys, so stepping through findings works with the viewer open.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { ChevronLeft, ChevronRight, ExternalLink, ImageOff, X } from "lucide-react";
import type { FeedPhoto } from "@/lib/gallery-api";
import { formatFindingPlace } from "@/lib/finding-place";
import { thumbUrl } from "@/lib/thumbs";
import { fitScale, type Size } from "@/lib/zoom-pan";
import { cn } from "@/lib/utils";
import { ZoomPan } from "@/components/gallery/ZoomPan";
import { FindingLocationMap, heatmapsHref } from "@/components/gallery/FindingLocationMap";

export type ViewerTab = "photo" | "location";
/** Past this zoom the original replaces the 1600 thumb. */
export const ORIGINAL_ABOVE = 2;

const TABS: Array<{ id: ViewerTab; label: string }> = [
  { id: "photo", label: "Photo" },
  { id: "location", label: "Location" },
];

/** The photo at "fit": its natural size scaled by fitScale(natural, stage), so
 *  the whole image is visible and re-fits when the stage resizes. The 1600
 *  thumb and the original share an aspect ratio, so the size is kept across
 *  the swap. */
function FitImage({ src, alt, onError, hi }: { src: string; alt: string; onError: () => void; hi: boolean }) {
  const stage = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState<Size>({ w: 0, h: 0 });
  const [natural, setNatural] = useState<Size>({ w: 0, h: 0 });
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const read = () => setStageSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const k = fitScale(natural, stageSize);
  const sized = k > 0;
  return (
    <div ref={stage} className="absolute inset-0 grid place-items-center overflow-hidden">
      <img
        data-testid="viewer-image"
        data-original={hi ? "1" : "0"}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={(e) => {
          const im = e.currentTarget;
          if (im.naturalWidth && !hi) setNatural({ w: im.naturalWidth, h: im.naturalHeight });
          else if (im.naturalWidth && natural.w === 0) setNatural({ w: im.naturalWidth, h: im.naturalHeight });
        }}
        onError={onError}
        className="select-none"
        style={sized ? { width: natural.w * k, height: natural.h * k } : { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
      />
    </div>
  );
}

export function FindingViewer({
  photo: p, crop, tab, onTab, onClose, onPrev, onNext, canPrev, canNext,
}: {
  photo: FeedPhoto;
  crop?: string;
  tab: ViewerTab;
  onTab: (t: ViewerTab) => void;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
}) {
  const [hi, setHi] = useState(false);
  const [broken, setBroken] = useState(false);
  useEffect(() => { setHi(false); setBroken(false); }, [p.image]);
  const onScale = useCallback((s: number) => { if (s > ORIGINAL_ABOVE) setHi(true); }, []);
  const place = formatFindingPlace(p);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPortal>
        <DialogOverlay className="z-[70] bg-black/75 backdrop-blur-sm" />
        <DialogPrimitive.Content
          data-testid="finding-viewer"
          aria-describedby={undefined}
          // The panel's window listener owns Esc (it closes the viewer first).
          onEscapeKeyDown={(e) => e.preventDefault()}
          className={cn(
            "fixed left-1/2 top-1/2 z-[71] flex h-[88vh] w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#101010] text-white shadow-2xl outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 duration-200 motion-reduce:animate-none",
          )}
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <div role="tablist" aria-label="Viewer" className="inline-flex gap-0.5 rounded-full bg-white/10 p-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`viewer-tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls="viewer-panel"
                  onClick={() => onTab(t.id)}
                  className={cn(
                    "rounded-full px-4 py-1 text-xs font-medium transition-colors motion-reduce:transition-none",
                    tab === t.id ? "bg-white text-black" : "text-white/70 hover:text-white",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-sm font-medium">
              {p.subject || "Finding"}
              {p.stage ? <span className="text-white/60"> · {p.stage}</span> : null}
            </DialogPrimitive.Title>
            <button type="button" aria-label="Previous finding" onClick={onPrev} disabled={!canPrev} className="rounded-full p-1.5 hover:bg-white/10 disabled:opacity-30">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button type="button" aria-label="Next finding" onClick={onNext} disabled={!canNext} className="rounded-full p-1.5 hover:bg-white/10 disabled:opacity-30">
              <ChevronRight className="h-4 w-4" />
            </button>
            <button type="button" aria-label="Close viewer" onClick={onClose} className="rounded-full p-1.5 hover:bg-white/10">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div
            key={tab}
            role="tabpanel"
            id="viewer-panel"
            aria-labelledby={`viewer-tab-${tab}`}
            className="scp-fade-in relative min-h-0 flex-1"
          >
            {tab === "photo" ? (
              broken ? (
                <div className="grid h-full place-items-center"><ImageOff className="h-8 w-8 text-white/50" aria-label="Photo unavailable" /></div>
              ) : (
                <ZoomPan className="h-full w-full" resetKey={p.image} onScale={onScale} testId="viewer-photo">
                  <FitImage
                    key={p.image}
                    src={hi ? p.image : thumbUrl(p.image, 1600)}
                    alt={p.caption || `${p.subject || "Scouting"} photo`}
                    onError={() => (hi ? setHi(false) : setBroken(true))}
                    hi={hi}
                  />
                </ZoomPan>
              )
            ) : (
              <>
                <ZoomPan className="h-full w-full" resetKey={`${p.entry}|${p.zone}`} testId="viewer-map">
                  <FindingLocationMap photo={p} crop={crop} size="large" />
                </ZoomPan>
                <div className="pointer-events-none absolute left-4 top-1 flex items-center gap-3">
                  <span data-testid="viewer-caption" className="rounded-full bg-black/60 px-3 py-1 text-xs font-medium backdrop-blur">
                    {[place, p.trap && `Trap ${p.trap}`].filter(Boolean).join(" · ") || "Place not recorded"}
                  </span>
                </div>
                <a
                  href={heatmapsHref(p, crop)}
                  onClick={onClose}
                  className="absolute bottom-3 left-4 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-white/90"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open in Heatmaps
                </a>
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
