/**
 * Scouting ▸ Gallery (spec 2026-10-11 GP1–GP4).
 *
 * Every scouting photo in the crop's scope for a date range, as a masonry of
 * natural-height tiles (CSS columns — no layout dependency), newest first,
 * a page at a time with infinite scroll. Filters: farm, greenhouse, kind,
 * observation, scout, dates. A tile opens the floating finding panel (prev/next).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { HEADER_PILL } from "@/components/header-controls";
import { PlacePicker } from "@/components/PlacePicker";
import { DateRangePicker } from "@/components/DateRangePicker";
import { PageHeader } from "@/components/PageHeader";
import { FindingPanel, KindPill } from "@/components/gallery/FindingPanel";
import { NO_PHOTOS_TEXT } from "@/components/gallery/ObservationGallery";
import { LoadProgress, firstLoad } from "@/components/Loading";
import { ThumbImg } from "@/components/gallery/ThumbImg";
import { cn } from "@/lib/utils";
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
import { ymd } from "@/lib/utils";
import { shortHouse } from "@/lib/places";
import { formatCapture } from "@/lib/capture-time";

const ALL = "__all__";

function lastThirtyDays() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(to.getDate() - 30);
  return { from: ymd(from), to: ymd(to) };
}

export { formatCapture };

/** The panel is 380px wide (capped to the viewport) at 1rem from the edge; at md+ the page
 * content makes that room, with the same 300ms curve as the panel's slide-in. */
export const PANEL_SHIFT = "md:pr-[calc(380px+2rem)]";
export const PANEL_SHIFT_TRANSITION =
  "transition-[padding] duration-300 ease-[cubic-bezier(0.22,0.61,0.36,1)] motion-reduce:transition-none";
export function contentPadClass(panelOpen: boolean): string {
  return cn(PANEL_SHIFT_TRANSITION, panelOpen && PANEL_SHIFT);
}

export function Gallery({ initialCrop }: { initialCrop?: string } = {}) {
  const crop = initialCrop ?? DEFAULT_CROP;
  const { farms, loading: farmsLoading } = useCropFarms(crop);
  // "" is "all" at each level (the place picker's value).
  const [farm, setFarm] = useState("");
  const [greenhouse, setGreenhouse] = useState("");
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
  // Whether any page has landed: the first load draws the masonry skeleton, a
  // filter change keeps the old photos under the inline progress bar.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  // Pages stay mounted (hidden) after you leave them, and the viewer is a
  // portal, so it must close itself when the route moves on.
  const isOpen = open != null;
  useEffect(() => {
    if (!isOpen) return;
    const close = () => setOpen(null);
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, [isOpen]);
  const gridRef = useRef<HTMLDivElement | null>(null);

  // Keep the selected tile in view once the grid has reflowed for the panel.
  useEffect(() => {
    if (open == null) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const t = window.setTimeout(() => {
      const el = gridRef.current?.querySelector<HTMLElement>(`[data-photo-index="${open}"]`);
      el?.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    }, reduce ? 0 : 320);
    return () => window.clearTimeout(t);
  }, [open]);

  const filters = useMemo<FeedFilters>(
    () => ({
      crop,
      from_date: from,
      to_date: to,
      farm,
      greenhouse,
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
        setLoaded(true);
      })
      .catch((e) => gen === generation.current && setError(errorText(e, "Could not load the gallery")))
      .finally(() => gen === generation.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loadingMoreRef = useRef(false);
  /** Resolves true when a page arrived, false when nothing was added. */
  const loadMore = useCallback(async (): Promise<boolean> => {
    if (loadingMoreRef.current || !hasMore) return false;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const gen = generation.current;
    try {
      const d = await fetchPhotoFeed(filters, page + 1);
      if (gen !== generation.current) return false;
      setPhotos((prev) => [...prev, ...(d.photos ?? [])]);
      setPage(page + 1);
      setHasMore(Boolean(d.hasMore));
      return (d.photos ?? []).length > 0;
    } catch (e) {
      if (gen === generation.current) setError(errorText(e, "Could not load more photos"));
      return false;
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

  const subjects = useMemo(
    () => (facets?.subjects ?? []).filter((s) => kind === ALL || s.kind === kind),
    [facets, kind],
  );

  return (
    <div className="flex min-h-svh w-full min-w-0 flex-col">
      <PageHeader eyebrow="Scouting · Photos from the field" title="Visual findings">
          <PlacePicker
            farms={farms}
            crop={crop}
            label="Visual findings place"
            value={{ farm, greenhouse }}
            onChange={(p) => {
              setFarm(p.farm);
              setGreenhouse(p.greenhouse);
            }}
            disabled={farmsLoading}
          />
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
          <Select value={subject} onValueChange={setSubject} disabled={!facets}>
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
          <Select value={scout} onValueChange={setScout} disabled={!facets}>
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
          <DateRangePicker label="Gallery date range" value={{ from, to }} onChange={setRange} />
      </PageHeader>
      <div
        data-testid="gallery-content"
        className={cn("flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-6 md:py-6", contentPadClass(open != null))}
      >

        <LoadProgress active={loading && loaded} />
        {error ? <div className="text-xs text-[var(--sd-data-red)]">{error}</div> : null}

        {firstLoad(loading, loaded) ? (
          <MasonrySkeleton />
        ) : photos.length ? (
          <>
            <div ref={gridRef} data-testid="gallery-masonry" className="columns-2 gap-3 sm:columns-3 lg:columns-4 2xl:columns-5">
              {photos.map((p, i) => (
                <GalleryTile key={`${p.entry}:${p.image}:${i}`} index={i} photo={p} onOpen={() => setOpen(i)} />
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
        <FindingPanel
          crop={crop}
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

export const TILE_SIZES = "(min-width:1536px) 20vw, (min-width:1024px) 25vw, (min-width:640px) 33vw, 50vw";

function GalleryTile({ photo: p, index, onOpen }: { photo: FeedPhoto; index: number; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  return (
    <figure data-testid="gallery-tile" data-photo-index={index} className="mb-3 break-inside-avoid overflow-hidden rounded-xl border bg-card shadow-[var(--sd-shadow-1)]">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open photo: ${p.subject || "photo"}`}
        className="group block w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {broken ? (
          <div className="grid aspect-[4/3] place-items-center bg-[var(--sd-bg-soft)] text-muted-foreground">
            <ImageOff className="h-5 w-5" aria-label="Photo unavailable" />
          </div>
        ) : (
          <ThumbImg
            src={p.image}
            width={480}
            sizes={TILE_SIZES}
            alt={p.caption || `${p.subject || "Scouting"} photo`}
            onError={() => setBroken(true)}
            className="transition-transform group-hover:scale-[1.02]"
          />
        )}
      </button>
      <figcaption className="flex flex-col gap-1.5 p-2.5 text-[0.72rem] leading-snug">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-medium">{p.subject || "Unlabelled"}</span>
          <KindPill kind={p.kind} />
        </div>
        <div className="flex items-center justify-between gap-2 text-muted-foreground tabular-nums">
          <span className="truncate">{shortHouse(p.house)}</span>
          <span className="shrink-0">{formatCapture(p.date)}</span>
        </div>
      </figcaption>
    </figure>
  );
}

function MasonrySkeleton() {
  const heights = [180, 240, 150, 210, 260, 170, 200, 230];
  return (
    <div className="columns-2 gap-3 sm:columns-3 lg:columns-4 2xl:columns-5" aria-busy="true">
      {heights.map((h, i) => (
        <div key={i} aria-hidden data-skeleton="tile" className="mb-3 break-inside-avoid animate-pulse rounded-xl border bg-muted/60" style={{ height: h }} />
      ))}
    </div>
  );
}
