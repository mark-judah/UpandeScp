/**
 * Pest gallery pop-up (roadmap item 8, spec 2026-10-10 G1–G5).
 *
 * `<ObservationName>` renders a pest or disease name; inside a
 * `<GalleryScopeProvider>` it becomes a button that opens the gallery for the
 * scope the surrounding view is showing (crop, range, farm, greenhouse). A
 * nested provider narrows its parent's scope — the greenhouse modal adds its
 * greenhouse. Outside any provider the name stays plain text, so a component
 * rendered somewhere without a scope never offers a pop-up it cannot fill.
 */
import { ThumbImg } from "@/components/gallery/ThumbImg";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ImageOff } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { errorText } from "@/lib/errors";
import { cn } from "@/lib/utils";
import {
  fetchObservationGallery,
  type GalleryPayload,
  type GalleryPhoto,
  type GalleryScope,
  type ObservationKind,
} from "@/lib/gallery-api";

export const NO_PHOTOS_TEXT =
  "No photos yet — scouts can add them when the manager allows photos (Settings → Spray plan → Scouting capture)";

const ScopeContext = createContext<GalleryScope | null>(null);

export function GalleryScopeProvider({
  scope,
  children,
}: {
  scope: Partial<GalleryScope>;
  children: ReactNode;
}) {
  const parent = useContext(ScopeContext);
  const key = JSON.stringify(scope);
  const merged = useMemo(() => {
    const own = Object.fromEntries(
      Object.entries(scope).filter(([, v]) => v !== undefined),
    ) as Partial<GalleryScope>;
    const next = { ...(parent ?? {}), ...own } as GalleryScope;
    return next.crop || next.from_date ? next : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parent, key]);
  return <ScopeContext.Provider value={merged}>{children}</ScopeContext.Provider>;
}

export function ObservationName({
  kind,
  name,
  className,
}: {
  kind: ObservationKind;
  name: string;
  className?: string;
}) {
  const scope = useContext(ScopeContext);
  const [open, setOpen] = useState(false);
  if (!scope || !name) return <span className={className}>{name}</span>;
  return (
    <>
      <button
        type="button"
        title={`Open the ${kind} gallery`}
        aria-label={`${name} — open gallery`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={cn(
          "min-w-0 truncate text-left underline-offset-2 decoration-[var(--sd-line)] hover:underline focus-visible:underline focus:outline-none",
          className,
        )}
      >
        {name}
      </button>
      {open && (
        <ObservationGalleryDialog scope={scope} kind={kind} name={name} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

export function ObservationGalleryDialog({
  scope,
  kind,
  name,
  onClose,
}: {
  scope: GalleryScope;
  kind: ObservationKind;
  name: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<GalleryPayload | null>(null);
  const [photos, setPhotos] = useState<GalleryPhoto[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchObservationGallery(scope, kind, name, 0)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setPhotos(d.photos ?? []);
        setPage(0);
        setHasMore(Boolean(d.photosHasMore));
      })
      .catch((e) => !cancelled && setError(errorText(e, "Could not load the gallery")));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(scope), kind, name]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const d = await fetchObservationGallery(scope, kind, name, page + 1);
      setPhotos((prev) => [...prev, ...(d.photos ?? [])]);
      setPage(page + 1);
      setHasMore(Boolean(d.photosHasMore));
    } catch (e) {
      setError(errorText(e, "Could not load more photos"));
    } finally {
      setLoadingMore(false);
    }
  };

  const ref = data?.reference;
  const where = scope.greenhouse || scope.farm || (scope.crop ? `All ${scope.crop} houses` : "All houses");

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[min(94vw,960px)] max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-baseline gap-x-2 gap-y-1 pr-6">
            <span>{ref?.commonName || name}</span>
            {ref?.scientificName ? (
              <span className="text-sm font-normal italic text-muted-foreground">{ref.scientificName}</span>
            ) : null}
            <span className="rounded-full border px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
              {kind}
            </span>
          </DialogTitle>
          <DialogDescription>
            {where} · {scope.from_date} → {scope.to_date}
          </DialogDescription>
        </DialogHeader>

        {error ? <div className="text-xs text-[var(--sd-data-red)]">{error}</div> : null}
        {!data && !error ? <div className="text-xs text-muted-foreground">Loading…</div> : null}

        {data && (
          <div className="flex flex-col gap-5 min-w-0">
            <section className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-4 items-start">
              {ref?.image ? (
                <a href={ref.image} target="_blank" rel="noreferrer" className="block">
                  <img
                    src={ref.image}
                    alt={`${name} reference`}
                    loading="lazy"
                    className="w-full aspect-[4/3] rounded-md border object-cover bg-[var(--sd-bg-soft)]"
                  />
                </a>
              ) : (
                <div className="w-full aspect-[4/3] rounded-md border bg-[var(--sd-bg-soft)] grid place-items-center text-muted-foreground">
                  <ImageOff className="h-5 w-5" aria-label="No reference image" />
                </div>
              )}
              <div className="text-sm leading-relaxed min-w-0">
                <div className="mb-1 text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
                  How to identify
                </div>
                {ref?.guideline ? (
                  <p className="whitespace-pre-line">{ref.guideline}</p>
                ) : (
                  <p className="text-muted-foreground">No identification guideline on the master yet.</p>
                )}
              </div>
            </section>

            <section className="min-w-0">
              <h3 className="mb-2 text-[0.78rem] font-medium uppercase tracking-wide text-muted-foreground">
                By scout
              </h3>
              {data.scouts.length ? (
                <div className="overflow-x-auto rounded-md border">
                  <table data-testid="gallery-scouts" className="w-full text-xs">
                    <thead className="bg-[var(--sd-bg-soft)] text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Scout</th>
                        <th className="px-3 py-2 text-right font-medium">Entries</th>
                        <th className="px-3 py-2 text-right font-medium">Stations</th>
                        {data.showCount ? <th className="px-3 py-2 text-right font-medium">Count</th> : null}
                        <th className="px-3 py-2 text-right font-medium">Houses</th>
                        <th className="px-3 py-2 text-right font-medium">Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.scouts.map((s) => (
                        <tr key={s.scout} className="border-t">
                          <td className="px-3 py-1.5">{s.scoutName || s.scout}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{s.entries}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{s.stations}</td>
                          {data.showCount ? (
                            <td className="px-3 py-1.5 text-right tabular-nums">{s.count ?? "—"}</td>
                          ) : null}
                          <td className="px-3 py-1.5 text-right tabular-nums">{s.houses}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{s.lastSeen}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Not recorded in this scope and range.</p>
              )}
            </section>

            <section className="min-w-0">
              <h3 className="mb-2 text-[0.78rem] font-medium uppercase tracking-wide text-muted-foreground">
                Photos
              </h3>
              {photos.length ? (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {photos.map((p, i) => (
                      <figure key={`${p.entry}:${p.image}:${i}`} data-testid="gallery-photo" className="min-w-0">
                        <a href={p.image} target="_blank" rel="noreferrer" className="block">
                          <ThumbImg
                            src={p.image}
                            width={240}
                            sizes="(min-width:768px) 20vw, (min-width:640px) 30vw, 45vw"
                            alt={p.caption || `${name} photo`}
                            placeholderClass="aspect-square"
                            className="aspect-square rounded-md border object-cover"
                          />
                        </a>
                        <figcaption className="mt-1 text-[0.7rem] leading-snug">
                          {p.caption ? <div className="line-clamp-2">{p.caption}</div> : null}
                          <div className="text-muted-foreground truncate">
                            {p.scoutName || p.scout} · {p.house} · {p.date}
                          </div>
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                  {hasMore ? (
                    <div className="mt-3 flex justify-center">
                      <button
                        type="button"
                        onClick={loadMore}
                        disabled={loadingMore}
                        className="rounded-full border px-3 py-1 text-xs hover:bg-muted disabled:opacity-60"
                      >
                        {loadingMore ? "Loading…" : "Load more"}
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">{NO_PHOTOS_TEXT}</p>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
