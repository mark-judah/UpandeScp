/**
 * A small carousel: slides side by side moved with a CSS transform (~250ms
 * ease), clickable dots under it, prev/next chevrons on hover, ←/→ when
 * focused, and swipe on touch. Past `maxDots` slides the dots become a
 * "3 / 14" counter.
 */
import { useRef, useState, type KeyboardEvent, type ReactNode, type TouchEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export const SWIPE_PX = 40;

/** The next index for a swipe of `dx` px (negative = finger moved left). */
export function swipeTarget(index: number, count: number, dx: number): number {
  if (Math.abs(dx) < SWIPE_PX) return index;
  return Math.max(0, Math.min(count - 1, index + (dx < 0 ? 1 : -1)));
}

export function DotCarousel({
  children,
  maxDots = 10,
  className,
  label = "Photos",
  onIndexChange,
}: {
  children: ReactNode[];
  maxDots?: number;
  className?: string;
  label?: string;
  onIndexChange?: (i: number) => void;
}) {
  const slides = children;
  const count = slides.length;
  const [index, setIndex] = useState(0);
  const startX = useRef<number | null>(null);
  const at = Math.min(index, Math.max(0, count - 1));

  const go = (i: number) => {
    const n = Math.max(0, Math.min(count - 1, i));
    setIndex(n);
    onIndexChange?.(n);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(at - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      go(at + 1);
    }
  };
  const onTouchStart = (e: TouchEvent) => {
    startX.current = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (startX.current == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? startX.current) - startX.current;
    startX.current = null;
    go(swipeTarget(at, count, dx));
  };

  if (!count) return null;
  const chevron =
    "absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/45 p-1 text-white opacity-0 transition-opacity hover:bg-black/60 group-hover:opacity-100 focus-visible:opacity-100";
  return (
    <div
      role="group"
      aria-roledescription="carousel"
      aria-label={label}
      tabIndex={0}
      onKeyDown={onKey}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      data-testid="dot-carousel"
      className={cn("group relative outline-none", className)}
    >
      <div className="overflow-hidden rounded-xl">
        <div
          className="flex transition-transform duration-[250ms] ease-in-out motion-reduce:transition-none"
          style={{ transform: `translateX(-${at * 100}%)` }}
        >
          {slides.map((s, i) => (
            <div
              key={i}
              className="w-full shrink-0"
              aria-hidden={i !== at}
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${count}`}
            >
              {s}
            </div>
          ))}
        </div>
      </div>
      {count > 1 && at > 0 ? (
        <button type="button" aria-label="Previous" onClick={() => go(at - 1)} className={cn(chevron, "left-1.5")}>
          <ChevronLeft className="h-4 w-4" />
        </button>
      ) : null}
      {count > 1 && at < count - 1 ? (
        <button type="button" aria-label="Next" onClick={() => go(at + 1)} className={cn(chevron, "right-1.5")}>
          <ChevronRight className="h-4 w-4" />
        </button>
      ) : null}
      {count > 1 ? (
        count > maxDots ? (
          <div className="mt-2 text-center text-[0.7rem] tabular-nums text-muted-foreground" data-testid="carousel-counter">
            {at + 1} / {count}
          </div>
        ) : (
          <div className="mt-2 flex justify-center gap-1.5" data-testid="carousel-dots">
            {slides.map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Slide ${i + 1}`}
                aria-current={i === at}
                onClick={() => go(i)}
                className={cn(
                  "h-1.5 rounded-full transition-all duration-200",
                  i === at ? "w-4 bg-foreground" : "w-1.5 bg-muted-foreground/40 hover:bg-muted-foreground/70",
                )}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
