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
