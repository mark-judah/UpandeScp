/**
 * Scouting photo thumbnails. The server (`common.thumbs.thumb`) resizes a
 * `/files/…` or `/private/files/…` image to WebP at 240 / 480 / 960 / 1600 px,
 * caches it on disk and — for public files — redirects to the static copy.
 * Anything else (data: URLs, external images) is returned untouched.
 */
export const THUMB_METHOD = "upande_scp.serverscripts.common.thumbs.thumb";
export const THUMB_WIDTHS = [240, 480, 960, 1600] as const;
export type ThumbWidth = (typeof THUMB_WIDTHS)[number];

export function isThumbable(src: string | null | undefined): src is string {
  return !!src && (src.startsWith("/files/") || src.startsWith("/private/files/")) && !/[?#]/.test(src);
}

export function thumbUrl(src: string, w: ThumbWidth): string {
  if (!isThumbable(src)) return src;
  return `/api/method/${THUMB_METHOD}?src=${encodeURIComponent(src)}&w=${w}`;
}

/** `"…w=480 480w, …w=960 960w"` — or "" when the source can't be thumbnailed. */
export function thumbSrcSet(src: string, widths: readonly ThumbWidth[] = [480, 960]): string {
  if (!isThumbable(src)) return "";
  return widths.map((w) => `${thumbUrl(src, w)} ${w}w`).join(", ");
}

const warmed = new Set<string>();
/** Fetch an image into the browser cache ahead of use (panel prev / next). */
export function preloadImage(url: string): void {
  if (!url || warmed.has(url) || typeof Image === "undefined") return;
  warmed.add(url);
  const im = new Image();
  im.decoding = "async";
  im.src = url;
}
