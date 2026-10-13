/**
 * Visual findings ▸ the detail panel: a floating card fixed to the right of the
 * viewport (the map card's look, pinned to the screen). The large photo, then
 * who found it, where, when and what. ← / → step through the photos, Esc / ✕
 * close. The photo opens full-size on click.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, ImageOff, X } from "lucide-react";
import { PersonAvatar } from "@/components/people/PersonAvatar";
import type { FeedPhoto, PhotoKind } from "@/lib/gallery-api";
import { formatCapture } from "@/lib/capture-time";
import { shortHouse } from "@/lib/places";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<PhotoKind, string> = { pest: "Pest", disease: "Disease", other: "Other" };

export function KindPill({ kind }: { kind: PhotoKind }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-1.5 py-px text-[0.6rem] font-medium uppercase tracking-wide",
        kind === "pest" && "text-[var(--sd-data-amber)]",
        kind === "disease" && "text-[var(--sd-data-purple)]",
        kind === "other" && "text-muted-foreground",
      )}
    >
      {KIND_LABEL[kind] ?? kind}
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** "Bed 4", "Zone 2" — the finest place the entry names. */
function spot(p: FeedPhoto): string {
  return [p.bed && `Bed ${p.bed}`, p.zone && `Zone ${p.zone}`, p.tree && `Tree ${p.tree}`]
    .filter(Boolean)
    .join(" · ");
}

export function FindingPanel({
  photos,
  index,
  hasMore,
  onIndex,
  onLoadMore,
  onClose,
}: {
  photos: FeedPhoto[];
  index: number;
  hasMore: boolean;
  onIndex: (i: number) => void;
  onLoadMore: () => Promise<boolean | void> | void;
  onClose: () => void;
}) {
  const p = photos[index];
  const atEnd = index >= photos.length - 1;
  const [zoomed, setZoomed] = useState(false);
  const [broken, setBroken] = useState(false);

  // "Next" past the last loaded photo loads the next page, then steps on.
  const pendingNext = useRef(false);
  useEffect(() => {
    if (pendingNext.current && index < photos.length - 1) {
      pendingNext.current = false;
      onIndex(index + 1);
    }
  }, [photos.length, index, onIndex]);
  useEffect(() => {
    setBroken(false);
    setZoomed(false);
  }, [p?.image]);

  const prev = () => index > 0 && onIndex(index - 1);
  const next = () => {
    if (!atEnd) onIndex(index + 1);
    else if (hasMore) {
      pendingNext.current = true;
      // A failed or empty page must not leave a later move auto-advancing.
      void Promise.resolve(onLoadMore()).then(
        (ok) => { if (ok === false) pendingNext.current = false; },
        () => { pendingNext.current = false; },
      );
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (zoomed) setZoomed(false);
        else onClose();
      } else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!p) return null;
  const where = [p.farm, p.greenhouse ? shortHouse(p.greenhouse) : p.house ? shortHouse(p.house) : ""]
    .filter(Boolean)
    .join(" · ");
  const place = spot(p);
  const isTrap = Boolean(p.trap);

  return (
    <>
      <aside
        role="dialog"
        aria-label={`Finding: ${p.subject || "photo"}`}
        data-testid="finding-panel"
        className={cn(
          "fixed bottom-4 right-4 top-4 z-50 flex w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border bg-card/95 shadow-[var(--sd-shadow-2,0_8px_24px_rgba(0,0,0,0.18))] backdrop-blur",
          "scp-panel-in",
        )}
      >
        <div className="flex items-start gap-2 p-4 pb-3">
          <div className="min-w-0 flex-1">
            <div className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground tabular-nums">
              Visual finding · {index + 1} of {photos.length}
              {hasMore ? "+" : ""}
            </div>
            <div className="flex items-center gap-2">
              <span className="min-w-0 truncate text-sm font-semibold" data-testid="finding-subject">
                {p.subject || "Unlabelled"}
              </span>
              <KindPill kind={p.kind} />
            </div>
          </div>
          <button
            type="button"
            aria-label="Close finding"
            onClick={onClose}
            className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="relative mx-4 grid min-h-[200px] place-items-center overflow-hidden rounded-xl bg-black/90">
            {broken ? (
              <ImageOff className="h-6 w-6 text-white/60" aria-label="Photo unavailable" />
            ) : (
              <button
                type="button"
                aria-label="View photo full size"
                onClick={() => setZoomed(true)}
                className="block w-full cursor-zoom-in"
              >
                <img
                  src={p.image}
                  alt={p.caption || `${p.subject || "Scouting"} photo`}
                  onError={() => setBroken(true)}
                  className="max-h-[42vh] w-full object-contain"
                />
              </button>
            )}
            <button
              type="button"
              aria-label="Previous photo"
              onClick={prev}
              disabled={index === 0}
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1.5 text-white hover:bg-black/70 disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="Next photo"
              onClick={next}
              disabled={atEnd && !hasMore}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1.5 text-white hover:bg-black/70 disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="flex flex-col gap-3 p-4 text-sm">
            <div className="flex items-center gap-2.5">
              <PersonAvatar id={p.scout} name={p.scoutName} image={p.scoutImage} size={40} />
              <div className="min-w-0">
                <div className="truncate font-medium" data-testid="lightbox-scout">{p.scoutName}</div>
                <div className="text-xs text-muted-foreground">Found by</div>
              </div>
            </div>
            <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
              <Row label="Where">
                <span data-testid="finding-where">{where || "—"}</span>
                {place ? <span className="text-muted-foreground"> · {place}</span> : null}
              </Row>
              {isTrap ? (
                <Row label="Trap">
                  {p.trap}
                  {p.trapLocation ? <span className="text-muted-foreground"> · {p.trapLocation}</span> : null}
                </Row>
              ) : null}
              <Row label="When">
                <span className="tabular-nums" data-testid="finding-when">
                  {formatCapture(p.capturedOn || p.date)}
                  {p.time && !/\d:\d/.test(p.capturedOn || "") ? ` · ${p.time}` : ""}
                </span>
              </Row>
              <Row label="What">
                {p.subject || "Unlabelled"}
                {p.stage ? <span className="text-muted-foreground"> · {p.stage}</span> : null}
              </Row>
              {isTrap && p.trapCount != null ? (
                <Row label="Highest count"><span className="tabular-nums">{p.trapCount}</span></Row>
              ) : p.count != null ? (
                <Row label="Count"><span className="tabular-nums">{p.count}</span></Row>
              ) : null}
            </dl>
            {p.caption ? <p className="whitespace-pre-line text-[0.8rem]">{p.caption}</p> : null}
            {p.notes ? (
              <div>
                <div className="mb-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">Notes</div>
                <p className="whitespace-pre-line text-[0.8rem]" data-testid="finding-notes">{p.notes}</p>
              </div>
            ) : null}
            <a
              href={`/app/scouting-entry/${encodeURIComponent(p.entry)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Open scouting entry <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </aside>

      {zoomed ? (
        <div
          role="presentation"
          data-testid="finding-zoom"
          onClick={() => setZoomed(false)}
          className="fixed inset-0 z-[60] grid cursor-zoom-out place-items-center bg-black/85 p-4"
        >
          <img src={p.image} alt={p.caption || `${p.subject || "Scouting"} photo, full size`} className="max-h-full max-w-full object-contain" />
        </div>
      ) : null}
    </>
  );
}
