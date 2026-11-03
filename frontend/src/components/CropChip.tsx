import { cn } from "@/lib/utils";

/**
 * The crop a block is growing, picked out of the block's name so it is the first
 * thing read when choosing a block in a pivot. Nothing when the block has no crop.
 */
export function CropChip({ crop, className }: { crop?: string | null; className?: string }) {
  if (!crop) return null;
  return (
    <span
      data-testid="crop-chip"
      className={cn(
        "inline-flex shrink-0 items-center rounded-full bg-emerald-500/20 px-2 py-0.5 text-[0.65rem] font-semibold leading-none text-emerald-700 dark:text-emerald-300",
        className,
      )}
    >
      {crop}
    </span>
  );
}
