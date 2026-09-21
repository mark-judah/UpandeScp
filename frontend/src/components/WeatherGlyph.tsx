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
 */

import { cn } from "@/lib/utils";

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

/** The shared cloud silhouette — every cloudy glyph reuses it verbatim. */
const CLOUD =
  "M7 19.5a4.75 4.75 0 0 1-.62-9.46 6.25 6.25 0 0 1 12.02-1.3A4.5 4.5 0 0 1 17.75 19.5H7Z";

/** Cloud raised slightly, for glyphs that hang precipitation beneath it. */
const CLOUD_HIGH =
  "M7 15.5a4.4 4.4 0 0 1-.58-8.76 5.8 5.8 0 0 1 11.15-1.2A4.2 4.2 0 0 1 17.4 15.5H7Z";

/** A filled teardrop whose tip points up, translated into place by the caller. */
function Drop({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return (
    <path
      transform={`translate(${x} ${y}) scale(${s})`}
      d="M0 0c1.15 1.5 1.8 2.5 1.8 3.3a1.8 1.8 0 0 1-3.6 0C-1.8 2.5-1.15 1.5 0 0Z"
    />
  );
}

/** A solid six-spoke flake. */
function Flake({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      {[0, 60, 120].map((deg) => (
        <rect
          key={deg}
          x={-1.85}
          y={-0.42}
          width={3.7}
          height={0.84}
          rx={0.42}
          transform={`rotate(${deg})`}
        />
      ))}
    </g>
  );
}

/** Sun disc with eight tapered rays. */
function SunBody({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  return (
    <g transform={`translate(${cx} ${cy})`}>
      <circle r={r} />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
        <rect
          key={deg}
          x={-0.62}
          y={-(r + 3.5)}
          width={1.24}
          height={2.1}
          rx={0.62}
          transform={`rotate(${deg})`}
        />
      ))}
    </g>
  );
}

function Glyph({ kind }: { kind: WeatherGlyphKind }) {
  switch (kind) {
    case "clear":
      return <SunBody cx={12} cy={12} r={5} />;

    case "partly":
      return (
        <>
          {/* Sun behind, dimmed so the cloud stays the dominant read. */}
          <g opacity={0.62}>
            <SunBody cx={9} cy={8.5} r={3.6} />
          </g>
          <path d={CLOUD} />
        </>
      );

    case "overcast":
      return (
        <>
          {/* Second cloud offset behind for a sense of layered cover. */}
          <path d={CLOUD_HIGH} opacity={0.4} transform="translate(2.5 -1.5)" />
          <path d={CLOUD} />
        </>
      );

    case "fog":
      return (
        <>
          <path d={CLOUD_HIGH} />
          <g opacity={0.55}>
            <rect x={4} y={17.4} width={16} height={1.5} rx={0.75} />
            <rect x={6.5} y={20.3} width={11} height={1.5} rx={0.75} />
          </g>
        </>
      );

    case "drizzle":
      return (
        <>
          <path d={CLOUD_HIGH} />
          <g opacity={0.72}>
            <Drop x={8.5} y={17.6} s={0.68} />
            <Drop x={12} y={18.6} s={0.68} />
            <Drop x={15.5} y={17.6} s={0.68} />
          </g>
        </>
      );

    case "rain":
      return (
        <>
          <path d={CLOUD_HIGH} />
          <g opacity={0.78}>
            <Drop x={8.4} y={17.2} />
            <Drop x={12} y={18.4} />
            <Drop x={15.6} y={17.2} />
          </g>
        </>
      );

    case "showers":
      return (
        <>
          <path d={CLOUD_HIGH} />
          {/* Slanted, to read as driven rather than steady rain. */}
          <g opacity={0.78} transform="rotate(14 12 18)">
            <Drop x={8.4} y={17.2} />
            <Drop x={12} y={18.6} />
            <Drop x={15.6} y={17.2} />
          </g>
        </>
      );

    case "snow":
      return (
        <>
          <path d={CLOUD_HIGH} />
          <g opacity={0.82}>
            <Flake x={8.3} y={19} s={0.92} />
            <Flake x={12} y={20.6} s={0.92} />
            <Flake x={15.7} y={19} s={0.92} />
          </g>
        </>
      );

    case "thunder":
      return (
        <>
          <path d={CLOUD_HIGH} />
          <path d="M12.9 16.1h3.3l-5.6 7.4 1.2-4.9H9.3l3.9-6.2-.3 3.7Z" />
        </>
      );

    default:
      // Unknown code: a plain cloud, deliberately flat so it reads as
      // "no forecast" rather than as a specific kind of weather.
      return <path d={CLOUD} opacity={0.55} />;
  }
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
    >
      <Glyph kind={kind} />
    </svg>
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
    >
      <path d="M12 2.5c3.4 4.6 5.6 7.9 5.6 10.6a5.6 5.6 0 0 1-11.2 0C6.4 10.4 8.6 7.1 12 2.5Z" />
    </svg>
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
    >
      <rect x={2} y={6} width={15} height={2.4} rx={1.2} />
      <rect x={2} y={10.8} width={20} height={2.4} rx={1.2} />
      <rect x={2} y={15.6} width={11} height={2.4} rx={1.2} />
    </svg>
  );
}
