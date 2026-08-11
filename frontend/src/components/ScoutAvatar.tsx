/**
 * Scout identity chip — who walked a greenhouse in a given week.
 *
 * The Employee photo is the intended presentation; initials are only used when
 * the record has no image. Most employees on this site have no photo yet, but
 * that's a data gap to close rather than a reason to design for initials.
 */

import { useState } from "react";
import { cn } from "@/lib/utils";

export interface Scout {
  employee: string;
  name: string;
  /** Employee.image — a Frappe file URL, empty when none is on file. */
  image: string;
  initials: string;
  entries: number;
}

/** Deterministic tint per employee so the same scout keeps one colour across
 *  weeks and views — used only behind initials, never over a photo. */
function tintFor(key: string): string {
  const tints = [
    "var(--sd-data-cyan)",
    "var(--sd-data-indigo)",
    "var(--sd-data-green)",
    "var(--sd-data-purple)",
    "var(--sd-data-amber)",
    "var(--sd-data-pink)",
  ];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return tints[h % tints.length];
}

export function ScoutAvatar({
  scout,
  size = 22,
  className,
}: {
  scout: Scout;
  size?: number;
  className?: string;
}) {
  // A broken/absent file shouldn't leave a torn image icon — fall through to
  // initials if the photo fails to load.
  const [broken, setBroken] = useState(false);
  const showImage = !!scout.image && !broken;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ring-1 ring-[var(--sd-line)]",
        className,
      )}
      style={{ width: size, height: size }}
      title={`${scout.name} · ${scout.entries} entr${scout.entries === 1 ? "y" : "ies"}`}
    >
      {showImage ? (
        <img
          src={scout.image}
          alt={scout.name}
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center font-semibold text-white"
          style={{
            background: tintFor(scout.employee || scout.name),
            fontSize: Math.round(size * 0.42),
          }}
        >
          {scout.initials}
        </span>
      )}
    </span>
  );
}

/** Row of scouts with an optional coverage figure. */
export function ScoutRow({
  scouts,
  coveragePct,
  bedsScouted,
  bedsTotal,
  className,
}: {
  scouts?: Scout[];
  coveragePct?: number | null;
  bedsScouted?: number;
  bedsTotal?: number;
  className?: string;
}) {
  if (!scouts?.length && coveragePct == null) return null;
  const full = coveragePct != null && coveragePct >= 99.5;
  return (
    <div className={cn("flex items-center gap-1.5 text-[0.65rem]", className)}>
      {scouts?.length ? (
        <>
          <span className="flex -space-x-1.5">
            {scouts.slice(0, 4).map((s) => (
              <ScoutAvatar key={s.employee || s.name} scout={s} />
            ))}
          </span>
          <span className="truncate text-muted-foreground">
            {scouts.length === 1
              ? scouts[0].name
              : `${scouts.length} scouts`}
          </span>
        </>
      ) : null}
      {coveragePct != null && (
        <span
          className={cn(
            "ml-auto shrink-0 rounded-full px-1.5 py-px tabular-nums ring-1",
            full
              ? "text-[var(--sd-data-green)] ring-[var(--sd-data-green)]"
              : "text-[var(--sd-data-amber)] ring-[var(--sd-data-amber)]",
          )}
          title={
            `${bedsScouted ?? "?"} of ${bedsTotal ?? "?"} beds had at least one record.` +
            (full ? " Whole house covered." : " Part of the house was not walked.")
          }
        >
          {coveragePct}% beds
        </span>
      )}
    </div>
  );
}
