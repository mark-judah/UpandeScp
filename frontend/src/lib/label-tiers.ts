/**
 * TS mirror of ``upande_scp.serverscripts.spray_plan_labels.plan_label``.
 *
 * The canonical tier table lives in ``upande_scp/upande_scp/shared/
 * label_tiers.json`` and is imported by both the Python PDF renderer
 * and this preview. Touching the JSON moves both in lockstep — there
 * is no second source of truth to drift.
 */
import tiersJson from "@shared/label_tiers.json";

export type Orientation = "row" | "stack";

export interface LabelPlan {
  tier: string;
  qrSideMm: number;
  fields: string[];
  basePt: number;
  headPt: number;
  orientation: Orientation;
  paddingTopMm: number;
  paddingRightMm: number;
  paddingBottomMm: number;
  paddingLeftMm: number;
}

interface TierRow {
  tier: string;
  min_dim_lt: number | null;
  qr_pct: number;
  qr_min_mm: number;
  fields: string[];
  base_pt: number;
  head_pt: number;
  orientation: Orientation;
}

interface TierConfig {
  min_dim_floor_mm: number;
  qr_min_dim_floor_mm: number;
  stack_ratio_threshold: number;
  tiers: TierRow[];
}

const CFG = tiersJson as TierConfig;

export const MIN_DIM_FLOOR_MM = CFG.min_dim_floor_mm;

export function planLabel(widthMm: number, heightMm: number): LabelPlan {
  const minDim = Math.min(widthMm, heightMm);

  // Pick the first tier whose ``min_dim_lt`` exceeds this label's
  // minimum dimension. ``null`` is the catch-all (xl).
  let tier: TierRow = CFG.tiers[CFG.tiers.length - 1];
  for (const t of CFG.tiers) {
    if (t.min_dim_lt === null || minDim < t.min_dim_lt) {
      tier = t;
      break;
    }
  }

  // Square-ish labels read better stacked even at row-default tiers.
  let orientation: Orientation = tier.orientation;
  const maxDim = Math.max(widthMm, heightMm);
  if (
    orientation === "row" &&
    maxDim / Math.max(minDim, 0.0001) < CFG.stack_ratio_threshold
  ) {
    orientation = "stack";
  }

  const qrSide = Math.max(tier.qr_min_mm, (minDim * tier.qr_pct) / 100);

  // Stack drops spatial fields first.
  let fields = [...tier.fields];
  if (orientation === "stack") {
    fields = fields.filter((f) => f !== "from" && f !== "to");
  }

  // xs is QR-only edge-to-edge; other tiers need a small uniform pad so
  // text doesn't hug the cut-line. Mirrors plan_label() in spray_plan_labels.py.
  const pad = tier.tier === "xs" ? 0.5 : 1.2;

  return {
    tier: tier.tier,
    qrSideMm: Math.round(qrSide * 1000) / 1000,
    fields,
    basePt: tier.base_pt,
    headPt: tier.head_pt,
    orientation,
    paddingTopMm: pad,
    paddingRightMm: pad,
    paddingBottomMm: pad,
    paddingLeftMm: pad,
  };
}
