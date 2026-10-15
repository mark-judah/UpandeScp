import { cn } from "@/lib/utils";

/**
 * "Clear" for a filter row: plain red text (no button chrome, no icon),
 * underlined on hover and on keyboard focus. Renders nothing unless a filter
 * is active.
 */
export function ClearFiltersLink({
  active,
  onClear,
  label = "Clear",
  className,
}: {
  active: boolean;
  onClear: () => void;
  label?: string;
  className?: string;
}) {
  if (!active) return null;
  return (
    <button
      type="button"
      onClick={onClear}
      className={cn(
        "cursor-pointer whitespace-nowrap rounded-sm px-1 text-xs font-medium text-destructive underline-offset-4 transition-colors hover:text-destructive/80 hover:underline focus-visible:text-destructive/80 focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40",
        className,
      )}
    >
      {label}
    </button>
  );
}

/** Backwards-compatible alias. */
export const ClearFiltersPill = ClearFiltersLink;
