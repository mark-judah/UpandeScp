import { useEffect, useRef, useState } from "react";
import "./OrbitProgress.css";

export interface OrbitProgressProps {
  /** 0–100. Drives both the centre readout and the orbit speed. */
  percent: number;
  /** Overall diameter in px. */
  size?: number;
  /** Track ring colour. */
  trackColor?: string;
  /** Orbiting arc colour. */
  arcColor?: string;
  /** Arc length as a fraction of the full circle (0–1). 0.25 = quarter arc. */
  arcFraction?: number;
  /** Ring thickness as a fraction of ``size``. Default 0.035 ≈ a thin
   *  arc; raise toward 0.1 for a chunkier track-disc look. */
  thickness?: number;
  /** Centre text colour (defaults to currentColor). */
  textColor?: string;
  /** Rotation duration in seconds at percent=0. The orbit accelerates
   *  linearly as percent climbs so duration at percent=100 is
   *  ``baseDurationSec / (1 + maxSpeedPlus)``. */
  baseDurationSec?: number;
  /** Acceleration ceiling. ``5`` means percent=100 spins six times faster
   *  than percent=0; matches the ``speedPlus="5"`` example from
   *  react-loading-indicators. */
  maxSpeedPlus?: number;
  /** Easing for the orbit animation. */
  easing?: "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out";
  /** Optional label below the percentage (e.g. "loading entries"). */
  label?: string;
  className?: string;
  /** When true, the displayed percentage eases toward ``percent`` instead
   *  of snapping. Smooths out the bursty 5→35→85→100 jumps that come
   *  from the dashboard aggregator's progress events. */
  smooth?: boolean;
}

/**
 * Orbit-style progress indicator: a fixed ring with a single disc
 * orbiting around it. Inspired by ``OrbitProgress variant="track-disc"``
 * from react-loading-indicators, but the orbit rate is data-driven —
 * the disc spins faster as ``percent`` rises so the visual urgency
 * matches the progress bar.
 */
export function OrbitProgress({
  percent,
  size = 96,
  trackColor = "currentColor",
  arcColor = "var(--primary, currentColor)",
  arcFraction = 0.28,
  thickness = 0.052,
  textColor,
  baseDurationSec = 1.1,
  easing = "linear",
  label,
  className,
  smooth = false,
}: OrbitProgressProps) {
  const target = Math.max(0, Math.min(100, percent));
  const [eased, setEased] = useState<number>(smooth ? 0 : target);
  const rafRef = useRef<number | null>(null);

  // Smooth interpolation: each frame nudge ``eased`` ~15% of the gap
  // toward the target. Stops when within 0.1% so we don't burn rAF
  // forever once the value has settled.
  useEffect(() => {
    if (!smooth) {
      setEased(target);
      return;
    }
    const step = () => {
      setEased((prev) => {
        const gap = target - prev;
        if (Math.abs(gap) < 0.1) return target;
        const next = prev + gap * 0.15;
        rafRef.current = requestAnimationFrame(step);
        return next;
      });
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, smooth]);

  const pct = Math.round(eased);

  // Constant cyclic motion — the spin rate is fixed and no longer driven by
  // ``percent`` (the centre readout still counts up as data loads).
  const duration = baseDurationSec;

  // SVG geometry: ring stroke is ``thickness`` (fraction of diameter);
  // the arc shares the track's radius and stroke width and is "drawn"
  // via stroke-dasharray so only ``arcFraction`` of the circumference
  // is visible at a time.
  const stroke = Math.max(1.5, size * thickness);
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const arcLen = Math.max(0.02, Math.min(0.95, arcFraction)) * circumference;

  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className={`orbit-progress ${className ?? ""}`.trim()}
      style={
        {
          width: size,
          height: size,
          color: textColor,
          ["--orbit-duration" as never]: `${duration}s`,
          ["--orbit-easing" as never]: easing,
        } as React.CSSProperties
      }
    >
      <svg
        className="orbit-progress__svg"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        overflow="visible"
      >
        <circle
          className="orbit-progress__track"
          cx={cx}
          cy={cy}
          r={r}
          stroke={trackColor}
          strokeWidth={stroke}
          fill="none"
        />
        <g
          className="orbit-progress__orbit"
          style={{ transformOrigin: `${cx}px ${cy}px` }}
        >
          <circle
            className="orbit-progress__arc"
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={arcColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${arcLen} ${circumference}`}
            // Start the arc at the top of the circle (12 o'clock) so it
            // travels clockwise from the same position the disc used to.
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        </g>
      </svg>
      <div className="orbit-progress__center" style={{ color: textColor }}>
        <span className="orbit-progress__pct">{pct}%</span>
        {label ? (
          <span className="orbit-progress__label">{label}</span>
        ) : null}
      </div>
    </div>
  );
}

export default OrbitProgress;
