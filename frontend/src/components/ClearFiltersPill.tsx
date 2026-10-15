import { X } from "lucide-react";
import { HEADER_PILL } from "@/components/header-controls";
import { cn } from "@/lib/utils";

/**
 * "Clear" for a filter row: FilterSelect's pill in the destructive (red)
 * accent. Renders nothing unless a filter is active.
 */
export function ClearFiltersPill({
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
        HEADER_PILL,
        "inline-flex min-w-0 cursor-pointer items-center justify-center whitespace-nowrap border border-destructive/30 text-destructive transition-all hover:bg-destructive/10",
        className,
      )}
    >
      <X className="h-3.5 w-3.5" aria-hidden />
      {label}
    </button>
  );
}
