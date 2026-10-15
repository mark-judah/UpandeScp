import { useState } from "react";
import { Map as MapIcon } from "lucide-react";
import { PestHeatmapModal } from "@/components/PestHeatmapModal";

/**
 * A plan's targets as pills; its "Open heatmap" button opens that pest's 3D heatmap for the
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
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full border bg-background py-0.5 pl-2.5 pr-0.5 text-[0.65rem] font-medium"
          >
            {t}
            <button
              type="button"
              disabled={!canOpen}
              onClick={() => setPicked(t)}
              aria-label={`Open heatmap for ${t}`}
              title={canOpen ? `3D heatmap of ${t} in ${greenhouse}` : "No greenhouse on this plan"}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[0.6rem] font-medium text-muted-foreground transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-muted disabled:hover:text-muted-foreground"
            >
              <MapIcon className="h-3 w-3" aria-hidden />
              Open heatmap
            </button>
          </span>
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
