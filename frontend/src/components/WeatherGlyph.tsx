/**
 * Solid weather glyphs.
 *
 * Lucide's weather set is line-art — an outlined cloud reads as a drawing of a
 * cloud rather than as weather, and at the 20px the forecast tile uses, the
 * strokes thin out and the shapes stop being recognisable at a glance.
 *
 * These are filled silhouettes instead: one shape, `currentColor`, no strokes.
 * Depth comes from layering at different opacities within the single colour —
 * the sun sits behind its cloud, drops read lighter than the cloud they fall
 * from — so a tile still needs only one colour to theme it.
 *
 * All glyphs share a 24×24 box and the same cloud silhouette, so the set looks
 * like one family and swapping codes doesn't shift the optical weight.
 *
 * The geometry lives in the one shared icon set
 * (upande_scp/shared/icons/weather/<kind>.svg, item 9b) and reaches this file
 * through the generated manifest; this module only keeps the exported API.
 */

import { cn } from "@/lib/utils";
import { sharedIconsOf } from "@/components/SharedIcon";

export type WeatherGlyphKind =
  | "clear"
  | "partly"
  | "overcast"
  | "fog"
  | "drizzle"
  | "rain"
  | "showers"
  | "snow"
  | "thunder"
  | "unknown";

const WEATHER = sharedIconsOf("weather");

/** Inner markup for a glyph; an unknown code draws the flat "no forecast" cloud. */
function glyphBody(kind: string): string {
  return (WEATHER[kind] ?? WEATHER.unknown).body;
}

export function WeatherGlyph({
  kind,
  className,
}: {
  kind: WeatherGlyphKind;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden
      className={cn("h-5 w-5 shrink-0", className)}
      dangerouslySetInnerHTML={{ __html: glyphBody(kind) }}
    />
  );
}

/** Small solid droplet for the precipitation-probability line. */
export function DropletGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={cn("h-3 w-3 shrink-0", className)}
      dangerouslySetInnerHTML={{ __html: glyphBody("droplet") }}
    />
  );
}

/** Small solid gust for the wind line. */
export function GustGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={cn("h-3 w-3 shrink-0", className)}
      dangerouslySetInnerHTML={{ __html: glyphBody("gust") }}
    />
  );
}
