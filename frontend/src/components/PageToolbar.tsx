import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The one controls row every SCP page uses: tabs / segmented control on the
 * LEFT, filters on the RIGHT, on the same row. It wraps only when it must
 * (a phone): the left slot first, then the filters. With no left slot the
 * filters stay right-aligned.
 */
export function PageToolbar({
  left,
  children,
  className,
}: {
  /** tabs / segmented control */
  left?: React.ReactNode;
  /** filters, toggles, Clear and icon tools */
  children?: React.ReactNode;
  className?: string;
}) {
  if (!left && !children) return null;
  return (
    <div
      data-testid="page-toolbar"
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}
    >
      {left ? (
        <div data-slot="left" className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          {left}
        </div>
      ) : null}
      {children ? (
        <div data-slot="right" className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}
