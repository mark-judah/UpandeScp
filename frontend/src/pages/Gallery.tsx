/**
 * Scouting ▸ Gallery (spec 2026-10-11 GP1–GP4).
 *
 * Every scouting photo in the crop's scope for a date range, as a masonry of
 * natural-height tiles (CSS columns — no layout dependency), newest first,
 * a page at a time with infinite scroll. Filters: farm, greenhouse, kind,
 * observation, scout, dates. A tile opens a lightbox with prev/next.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, ImageOff } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogTitle,
} from "@/components/ui/dialog";
import { HEADER_PILL } from "@/components/header-controls";
import { DatePicker } from "@/components/DatePicker";
import { PageHeader } from "@/components/PageHeader";
import { PersonAvatar } from "@/components/people/PersonAvatar";
import { NO_PHOTOS_TEXT } from "@/components/gallery/ObservationGallery";
import { useCropFarms } from "@/hooks/use-crop-farms";
import {
  fetchPhotoFeed,
  type FeedFacets,
  type FeedFilters,
  type FeedPhoto,
  type PhotoKind,
} from "@/lib/gallery-api";
import { errorText } from "@/lib/errors";
import { DEFAULT_CROP } from "@/lib/scouting-api";
import { cn, ymd } from "@/lib/utils";

const ALL = "__all__";

function lastThirtyDays() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(to.getDate() - 30);
  return { from: ymd(from), to: ymd(to) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2031-12-01 08:05:00" → "1 Dec 2031 · 08:05"; a bare date stays a date. */
export function formatCapture(stamp: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(stamp || "");
  if (!m) return stamp || "";
  const day = `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  return m[4] ? `${day} · ${m[4]}:${m[5]}` : day;
}

function shortHouse(h: string): string {
  return h ? h.split(" - ")[0] : "";
}

const KIND_LABEL: Record<PhotoKind, string> = { pest: "Pest", disease: "Disease", other: "Other" };

export function Gallery({ initialCrop }: { initialCrop?: string } = {}) {
  const crop = initialCrop ?? DEFAULT_CROP;
  const { farms } = useCropFarms(crop);
  const [farm, setFarm] = useState<string>(ALL);
  const [greenhouse, setGreenhouse] = useState<string>(ALL);
  const [kind, setKind] = useState<string>(ALL);
  const [subject, setSubject] = useState<string>(ALL);
  const [scout, setScout] = useState<string>(ALL);
  const [{ from, to }, setRange] = useState(lastThirtyDays);

  const [photos, setPhotos] = useState<FeedPhoto[]>([]);
  const [facets, setFacets] = useState<FeedFacets | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const filters = useMemo<FeedFilters>(
    () => ({
      crop,
      from_date: from,
      to_date: to,
      farm: farm === ALL ? "" : farm,
      greenhouse: greenhouse === ALL ? "" : greenhouse,
      kind: kind === ALL ? "" : (kind as PhotoKind),
      name: subject === ALL ? "" : subject,
      scout: scout === ALL ? "" : scout,
    }),
    [crop, from, to, farm, greenhouse, kind, subject, scout],
  );
  const key = JSON.stringify(filters);
  // Bumped on every filter change; a response for an older key is dropped.
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    setLoading(true);
    setError(null);
    setOpen(null);
    fetchPhotoFeed(filters, 0)
      .then((d) => {
        if (gen !== generation.current) return;
        setPhotos(d.photos ?? []);
        setPage(0);
        setHasMore(Boolean(d.hasMore));
        if (d.facets) setFacets(d.facets);
      })
      .catch((e) => gen === generation.current && setError(errorText(e, "Could not load the gallery")))
      .finally(() => gen === generation.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loadingMoreRef = useRef(false);
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMore) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const gen = generation.current;
    try {
      const d = await fetchPhotoFeed(filters, page + 1);
      if (gen !== generation.current) return;
      setPhotos((prev) => [...prev, ...(d.photos ?? [])]);
      setPage(page + 1);
      setHasMore(Boolean(d.hasMore));
    } catch (e) {
      if (gen === generation.current) setError(errorText(e, "Could not load more photos"));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [filters, page, hasMore]);

  // Infinite scroll: a sentinel under the grid loads the next page as it nears
  // the viewport. The "Load more" button stays as the keyboard / fallback path.
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (es) => es.some((e) => e.isIntersecting) && void loadMore(),
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

  const farmNames = useMemo(() => Object.keys(farms).sort(), [farms]);
  const houses = useMemo(() => {
    const list = farm === ALL ? Object.values(farms).flat() : farms[farm] || [];
    return Array.from(new Set(list)).sort();
  }, [farms, farm]);
  const subjects = useMemo(
    () => (facets?.subjects ?? []).filter((s) => kind === ALL || s.kind === kind),
    [facets, kind],
  );

  return (
    <div className="flex min-h-svh w-full min-w-0 flex-col">
      <PageHeader eyebrow="Scouting · Photos from the field" title="Gallery" />
      <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Select
            value={farm}
            onValueChange={(v) => {
              setFarm(v);
              setGreenhouse(ALL);
            }}
          >
            <SelectTrigger aria-label="Gallery farm" className={HEADER_PILL}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All Farms</SelectItem>
              {farmNames.map((f) => (
                <SelectItem key={f} value={f}>{f}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={greenhouse} onValueChange={setGreenhouse}>
            <SelectTrigger aria-label="Gallery greenhouse" className={HEADER_PILL}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All Houses</SelectItem>
              {houses.map((h) => (
                <SelectItem key={h} value={h}>{shortHouse(h)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={kind}
            onValueChange={(v) => {
              setKind(v);
              setSubject(ALL);
            }}
          >
            <SelectTrigger aria-label="Gallery kind" className={HEADER_PILL}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Pests & diseases</SelectItem>
              <SelectItem value="pest">Pests</SelectItem>
              <SelectItem value="disease">Diseases</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
          <Select value={subject} onValueChange={setSubject}>
            <SelectTrigger aria-label="Gallery observation" className={HEADER_PILL}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All observations</SelectItem>
              {subjects.map((s) => (
                <SelectItem key={s.name} value={s.name}>
                  {s.name} · {s.count}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={scout} onValueChange={setScout}>
            <SelectTrigger aria-label="Gallery scout" className={HEADER_PILL}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All scouts</SelectItem>
              {(facets?.scouts ?? []).map((s) => (
                <SelectItem key={s.scout} value={s.scout}>
                  {s.scoutName} · {s.count}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DatePicker value={from} onChange={(v) => setRange({ from: v, to })} />
          <DatePicker value={to} onChange={(v) => setRange({ from, to: v })} />
        </div>

        {error ? <div className="text-xs text-[var(--sd-data-red)]">{error}</div> : null}

        {loading ? (
          <MasonrySkeleton />
        ) : photos.length ? (
          <>
            <div data-testid="gallery-masonry" className="columns-2 gap-3 sm:columns-3 lg:columns-4 2xl:columns-5">
              {photos.map((p, i) => (
                <GalleryTile key={`${p.entry}:${p.image}:${i}`} photo={p} onOpen={() => setOpen(i)} />
              ))}
            </div>
            <div ref={sentinel} aria-hidden className="h-px" />
            {hasMore ? (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="rounded-full border px-4 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            ) : (
              <p className="text-center text-[0.7rem] text-muted-foreground">
                {photos.length} photo{photos.length === 1 ? "" : "s"} · that's all in this range
              </p>
            )}
          </>
        ) : !error ? (
          <div className="grid place-items-center rounded-[20px] border border-dashed py-16 text-center">
            <ImageOff className="mb-2 h-6 w-6 text-muted-foreground" aria-hidden />
            <p className="max-w-md text-xs text-muted-foreground">{NO_PHOTOS_TEXT}</p>
          </div>
        ) : null}
      </div>

      {open != null && photos[open] ? (
        <Lightbox
          photos={photos}
          index={open}
          hasMore={hasMore}
          onIndex={setOpen}
          onLoadMore={loadMore}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

function GalleryTile({ photo: p, onOpen }: { photo: FeedPhoto; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  return (
    <figure data-testid="gallery-tile" className="mb-3 break-inside-avoid overflow-hidden rounded-xl border bg-card shadow-[var(--sd-shadow-1)]">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open photo: ${p.subject || "photo"} by ${p.scoutName}`}
        className="group block w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {broken ? (
          <div className="grid aspect-[4/3] place-items-center bg-[var(--sd-bg-soft)] text-muted-foreground">
            <ImageOff className="h-5 w-5" aria-label="Photo unavailable" />
          </div>
        ) : (
          <img
            src={p.image}
            alt={p.caption || `${p.subject || "Scouting"} photo`}
            loading="lazy"
            onError={() => setBroken(true)}
            className="block w-full bg-[var(--sd-bg-soft)] transition-transform duration-300 group-hover:scale-[1.02]"
          />
        )}
      </button>
      <figcaption className="flex flex-col gap-1.5 p-2.5 text-[0.72rem] leading-snug">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-medium">{p.subject || "Unlabelled"}</span>
          <KindPill kind={p.kind} />
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <PersonAvatar id={p.scout} name={p.scoutName} image={p.scoutImage} size={20} />
          <span className="min-w-0 flex-1 truncate">{p.scoutName}</span>
        </div>
        <div className="flex items-center justify-between gap-2 text-muted-foreground tabular-nums">
          <span className="truncate">{shortHouse(p.house)}</span>
          <span className="shrink-0">{formatCapture(p.date)}</span>
        </div>
      </figcaption>
    </figure>
  );
}

function KindPill({ kind }: { kind: PhotoKind }) {
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

function MasonrySkeleton() {
  const heights = [180, 240, 150, 210, 260, 170, 200, 230];
  return (
    <div className="columns-2 gap-3 sm:columns-3 lg:columns-4 2xl:columns-5" aria-busy>
      {heights.map((h, i) => (
        <div key={i} className="mb-3 break-inside-avoid animate-pulse rounded-xl border bg-muted/60" style={{ height: h }} />
      ))}
    </div>
  );
}

export function Lightbox({
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
  onLoadMore: () => Promise<void> | void;
  onClose: () => void;
}) {
  const p = photos[index];
  const atEnd = index >= photos.length - 1;
  // "Next" past the last loaded photo loads the next page, then steps on.
  const pendingNext = useRef(false);
  useEffect(() => {
    if (pendingNext.current && index < photos.length - 1) {
      pendingNext.current = false;
      onIndex(index + 1);
    }
  }, [photos.length, index, onIndex]);

  const prev = () => index > 0 && onIndex(index - 1);
  const next = () => {
    if (!atEnd) onIndex(index + 1);
    else if (hasMore) {
      pendingNext.current = true;
      void onLoadMore();
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-w-[min(96vw,1100px)] max-h-[92vh] overflow-y-auto p-0"
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") prev();
          if (e.key === "ArrowRight") next();
        }}
      >
        <div className="grid grid-cols-1 md:grid-cols-[1fr_280px]">
          <div className="relative grid min-h-[40vh] place-items-center bg-black">
            <img
              src={p.image}
              alt={p.caption || `${p.subject || "Scouting"} photo`}
              className="max-h-[80vh] w-auto max-w-full object-contain"
            />
            <button
              type="button"
              aria-label="Previous photo"
              onClick={prev}
              disabled={index === 0}
              className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70 disabled:opacity-30"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              aria-label="Next photo"
              onClick={next}
              disabled={atEnd && !hasMore}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70 disabled:opacity-30"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
          <div className="flex flex-col gap-3 p-4 text-sm">
            <div>
              <DialogTitle className="flex items-center gap-2 pr-6 text-base">
                <span className="min-w-0 truncate">{p.subject || "Unlabelled"}</span>
                <KindPill kind={p.kind} />
              </DialogTitle>
              <DialogDescription className="text-xs tabular-nums">
                {index + 1} of {photos.length}
                {hasMore ? "+" : ""}
              </DialogDescription>
            </div>
            {p.caption ? <p className="whitespace-pre-line text-[0.8rem]">{p.caption}</p> : null}
            <div className="flex items-center gap-2.5">
              <PersonAvatar id={p.scout} name={p.scoutName} image={p.scoutImage} size={40} />
              <div className="min-w-0">
                <div className="truncate font-medium" data-testid="lightbox-scout">{p.scoutName}</div>
                <div className="text-xs text-muted-foreground">Scout</div>
              </div>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">House</dt>
              <dd className="truncate">{p.house || "—"}</dd>
              <dt className="text-muted-foreground">Captured</dt>
              <dd className="tabular-nums">{formatCapture(p.capturedOn || p.date)}</dd>
            </dl>
            <a
              href={`/app/scouting-entry/${encodeURIComponent(p.entry)}`}
              target="_blank"
              rel="noreferrer"
              className="mt-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Open scouting entry <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
