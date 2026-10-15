import { useState } from "react";
import { PestHeatmapModal } from "@/components/PestHeatmapModal";

/**
 * A plan's targets as pills; clicking one opens that pest's heatmap for the
 * plan's greenhouse so the approver can see whether it is really there. Owns
 * the modal, so a host only passes the plan's greenhouse and crop.
 */
export function TargetPills({
  targets,
  greenhouse,
  crop,
  toDate,
}: {
  targets: string[];
  greenhouse?: string | null;
  crop: string;
  /** Window end; a plan's spray date makes the picture match the decision. */
  toDate?: string;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const canOpen = !!greenhouse;
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {targets.map((t) => (
          <button
            key={t}
            type="button"
            disabled={!canOpen}
            onClick={() => setPicked(t)}
            title={canOpen ? `Heatmap of ${t} in ${greenhouse}` : undefined}
            className="inline-flex items-center rounded-full border bg-background px-2.5 py-0.5 text-[0.65rem] font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-default disabled:opacity-70"
          >
            {t}
          </button>
        ))}
      </div>
      <PestHeatmapModal
        greenhouse={greenhouse ?? null}
        observation={picked}
        crop={crop}
        toDate={toDate}
        onClose={() => setPicked(null)}
      />
    </>
  );
}
