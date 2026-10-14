/**
 * A scouting photo as a thumbnail: WebP from the thumb service with a
 * 1x / 2x srcset, lazy + async decoding, and a pulsing placeholder (with a
 * reserved aspect ratio) until the image has loaded, so the grid doesn't jump.
 */
import { useState, type ImgHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { isThumbable, thumbSrcSet, thumbUrl, type ThumbWidth } from "@/lib/thumbs";

export function ThumbImg({
  src,
  width = 480,
  sizes,
  alt,
  className,
  placeholderClass = "aspect-[4/3]",
  onError,
  ...rest
}: {
  src: string;
  width?: ThumbWidth;
  sizes?: string;
  placeholderClass?: string;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "srcSet" | "sizes" | "width">) {
  const [loaded, setLoaded] = useState(false);
  const thumb = isThumbable(src);
  return (
    <div className={cn("relative bg-[var(--sd-bg-soft)]", !loaded && placeholderClass, !loaded && "animate-pulse")} data-loaded={loaded}>
      <img
        {...rest}
        src={thumb ? thumbUrl(src, width) : src}
        srcSet={thumb ? thumbSrcSet(src, [width, Math.min(1600, width * 2) as ThumbWidth]) : undefined}
        sizes={thumb ? sizes : undefined}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={onError}
        className={cn("block w-full transition-opacity duration-300 motion-reduce:transition-none", loaded ? "opacity-100" : "opacity-0", className)}
      />
    </div>
  );
}
