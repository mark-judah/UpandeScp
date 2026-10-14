import { call } from "@/lib/frappe";

/** Pest gallery pop-up (roadmap item 8, spec G1–G5). */
export type ObservationKind = "pest" | "disease";

export interface GalleryScope {
  crop: string;
  from_date: string;
  to_date: string;
  farm?: string;
  greenhouse?: string;
}

export interface GalleryScoutRow {
  scout: string;
  scoutName: string;
  entries: number;
  stations: number;
  /** null for a disease — diseases are not counted (G2). */
  count: number | null;
  houses: number;
  lastSeen: string;
}

export interface GalleryPhoto {
  image: string;
  caption: string;
  capturedOn: string;
  scout: string;
  scoutName: string;
  house: string;
  date: string;
  entry: string;
}

export interface GalleryPayload {
  kind: ObservationKind;
  name: string;
  reference: { commonName: string; scientificName: string; guideline: string; image: string };
  showCount: boolean;
  scouts: GalleryScoutRow[];
  photos: GalleryPhoto[];
  photosPage: number;
  photosHasMore: boolean;
}

export const GALLERY_METHOD = "upande_scp.serverscripts.dashboard_aggregates.observation_gallery";

export async function fetchObservationGallery(
  scope: GalleryScope,
  kind: ObservationKind,
  name: string,
  page = 0,
): Promise<GalleryPayload> {
  const resp = await call<{ message?: GalleryPayload } | GalleryPayload>(GALLERY_METHOD, {
    ...scope,
    farm: scope.farm || "",
    greenhouse: scope.greenhouse || "",
    kind,
    name,
    page,
  });
  return ((resp as { message?: GalleryPayload })?.message ?? resp) as GalleryPayload;
}

/* ── Gallery page (spec 2026-10-11 GP2) ─────────────────────────────── */

export type PhotoKind = ObservationKind | "other";

export interface FeedPhoto extends GalleryPhoto {
  subject: string;
  kind: PhotoKind;
  /** Employee.image of the scout — initials only when empty. */
  scoutImage: string;
  /** Where / what, for the detail panel (all optional: older payloads omit them). */
  farm?: string;
  greenhouse?: string;
  block?: string;
  bed?: string;
  zone?: string;
  tree?: string;
  /** HH:MM of the entry. */
  time?: string;
  trap?: string;
  trapLocation?: string;
  /** The trap's highest count on that entry (trap photos only). */
  trapCount?: number | null;
  stage?: string;
  count?: number | null;
  notes?: string;
}

export interface FeedFacets {
  subjects: Array<{ name: string; kind: PhotoKind; count: number }>;
  scouts: Array<{ scout: string; scoutName: string; image: string; count: number }>;
}

export interface FeedFilters extends GalleryScope {
  kind?: PhotoKind | "";
  name?: string;
  scout?: string;
}

export interface FeedPayload {
  photos: FeedPhoto[];
  page: number;
  hasMore: boolean;
  pageSize: number;
  /** Page 0 only. */
  facets?: FeedFacets;
}

export const PHOTO_FEED_METHOD = "upande_scp.serverscripts.dashboard_aggregates.photo_feed";

export async function fetchPhotoFeed(filters: FeedFilters, page = 0): Promise<FeedPayload> {
  const resp = await call<{ message?: FeedPayload } | FeedPayload>(PHOTO_FEED_METHOD, {
    crop: filters.crop,
    from_date: filters.from_date,
    to_date: filters.to_date,
    farm: filters.farm || "",
    greenhouse: filters.greenhouse || "",
    kind: filters.kind || "",
    name: filters.name || "",
    scout: filters.scout || "",
    page,
  });
  return ((resp as { message?: FeedPayload })?.message ?? resp) as FeedPayload;
}
