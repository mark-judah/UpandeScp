import type { Pt } from "@/lib/hull";
import { PinForm } from "@/pages/dashboard/PinForm";
import type { DrawArea } from "./use-draw-area";

/** "Draw area" → corners with Finish / Cancel → the pin form for the drawn area. */
export function DrawAreaBar({
  draw,
  pending,
  busy,
  disabled,
  defaultTitle,
  onSave,
  onDiscard,
}: {
  draw: DrawArea;
  pending: Pt[] | null;
  busy?: boolean;
  disabled?: boolean;
  defaultTitle: string;
  onSave: (title: string, shared: boolean) => void;
  onDiscard: () => void;
}) {
  if (pending) return <PinForm defaultTitle={defaultTitle} busy={busy} onSave={onSave} onCancel={onDiscard} />;
  if (draw.active) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-[0.7rem]">
        <span className="text-muted-foreground">Click to add corners · double-click or Finish to close · Esc cancels</span>
        <button
          type="button"
          onClick={draw.finish}
          disabled={draw.vertices.length < 3}
          className="rounded border px-2 py-0.5 hover:bg-muted disabled:opacity-50"
        >
          Finish
        </button>
        <button type="button" onClick={draw.cancel} className="rounded border px-2 py-0.5 hover:bg-muted">
          Cancel
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={draw.start}
      disabled={disabled}
      className="self-start rounded border px-2 py-0.5 text-[0.7rem] hover:bg-muted disabled:opacity-50"
    >
      Draw area
    </button>
  );
}
