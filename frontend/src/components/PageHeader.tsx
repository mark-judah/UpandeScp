import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Shared page header, styled to the reference `.pagehead`: an uppercase
 * eyebrow with a leading rule over a large editorial title, sitting as plain
 * text on the same paper background as the content (no header bar, not
 * sticky). Optional ``children`` render as a right-aligned tools cluster on
 * the same baseline as the title.
 */
export function PageHeader({
  title,
  eyebrow,
  switcher,
  children,
}: {
  title: React.ReactNode;
  eyebrow?: React.ReactNode;
  /** A pill switcher (e.g. TabsList) rendered on the LEFT of the controls
   *  row, on the same line as the right-aligned dropdowns. */
  switcher?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 bg-transparent px-4 pt-5 pb-2 md:px-6 md:pt-6 md:pb-3">
      {/* Title (the sidebar collapse toggle now lives in the sidebar). */}
      <div className="min-w-0">
        {eyebrow ? (
          <div className="mb-2.5 flex items-center gap-2.5 text-[11px] font-medium uppercase tracking-[0.2em] text-[var(--sd-quiet)]">
            <span className="h-px w-[18px] shrink-0 bg-[var(--sd-text)]" />
            <span className="truncate">{eyebrow}</span>
          </div>
        ) : null}
        <h1 className="text-[28px] font-semibold leading-[1.05] tracking-[-0.03em] text-foreground md:text-[40px]">
          {title}
        </h1>
      </div>
      {/* Controls row — BELOW the heading. The switcher (if any) sits on the
          left and the dropdowns on the right, on the same line (matching the
          dashboard). Without a switcher the controls are right-aligned. */}
      {switcher || children ? (
        <div
          className={cn(
            "flex flex-wrap items-center gap-3",
            switcher ? "justify-between" : "justify-end",
          )}
        >
          {switcher ? (
            <div className="flex items-center gap-2">{switcher}</div>
          ) : null}
          {children ? (
            <div className="flex flex-wrap items-center gap-2">{children}</div>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
