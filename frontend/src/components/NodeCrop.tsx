/**
 * Crop on a Farm Structure node: `CropBadge` is the SVG pill drawn on a tree
 * node (solid when set there, muted when inherited or overridden by a crop
 * cycle, a dashed "Set crop" for editors when nothing is set), and
 * `NodeCropEditor` is the searchable picker that sets or clears it.
 */
import { useEffect, useState } from "react";
import { SearchSelect } from "@/components/SearchSelect";
import { ClearFiltersPill } from "@/components/ClearFiltersPill";
import { HEADER_PILL } from "@/components/header-controls";
import { cn } from "@/lib/utils";
import { cropPill } from "@/lib/structure-tree";
import type { NodeCrop } from "@/lib/structure-api";

const FONT = "Poppins, system-ui, sans-serif";

export function CropBadge({
  crop, x, y, maxWidth, editable, onEdit,
}: {
  crop: NodeCrop | undefined;
  x: number;
  y: number;
  maxWidth: number;
  editable: boolean;
  onEdit: () => void;
}) {
  const spec = cropPill(crop);
  if (spec.tone === "none" && !editable) return null;
  const empty = spec.tone === "none";
  const raw = empty ? "Set crop" : spec.text;
  const text = raw.length > 30 ? `${raw.slice(0, 29)}…` : raw;
  const w = Math.min(maxWidth, text.length * 5.6 + 16);
  const solid = spec.tone === "own";
  return (
    <g
      data-testid="crop-badge"
      data-tone={spec.tone}
      role={editable ? "button" : undefined}
      aria-label={editable ? `Edit crop: ${raw}` : `Crop: ${raw}`}
      style={{ cursor: editable ? "pointer" : "default" }}
      onClick={(e) => {
        if (!editable) return;
        e.stopPropagation();
        onEdit();
      }}
    >
      <rect
        x={x} y={y} width={w} height={14} rx={7}
        fill={solid ? "var(--sd-text)" : "none"}
        stroke={solid ? "none" : "var(--sd-quiet)"}
        strokeWidth={1} strokeDasharray={empty ? "3 2" : undefined}
        strokeOpacity={0.7}
      />
      <text
        x={x + w / 2} y={y + 10} textAnchor="middle" fontSize={9.5} fontWeight={500}
        fontFamily={FONT} fill={solid ? "var(--sd-bg-soft)" : "var(--sd-quiet)"}
      >
        {text}
      </text>
    </g>
  );
}

export function NodeCropEditor({
  label, current, crops, saving, onSave, onClose,
}: {
  label: string;
  /** the crop set on the node itself, if any */
  current: string | null;
  crops: string[];
  saving?: boolean;
  onSave: (crop: string | null) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState<string | null>(current);
  useEffect(() => setValue(current), [current, label]);
  const options = crops.map((c) => ({ value: c, label: c }));
  return (
    <div
      role="group"
      aria-label={`Crop for ${label}`}
      className="flex flex-wrap items-center gap-3 rounded-[var(--sd-radius)] bg-card p-3 shadow-[var(--sd-shadow-1)]"
    >
      <span className="text-sm">
        Crop for <b className="font-semibold">{label}</b>
      </span>
      <div className="w-56">
        <SearchSelect
          ariaLabel="Crop"
          value={value}
          options={options}
          onChange={setValue}
          placeholder="Choose a crop"
          noneLabel="No crop (inherit)"
          disabled={saving}
        />
      </div>
      <button
        type="button"
        disabled={saving || value === current}
        onClick={() => onSave(value)}
        className={cn(HEADER_PILL, "inline-flex cursor-pointer items-center justify-center disabled:opacity-50")}
      >
        {saving ? "Saving…" : "Save"}
      </button>
      <ClearFiltersPill active={!!current} label="Clear crop" onClear={() => onSave(null)} />
      <button
        type="button"
        onClick={onClose}
        className={cn(HEADER_PILL, "inline-flex cursor-pointer items-center justify-center")}
      >
        Close
      </button>
    </div>
  );
}
