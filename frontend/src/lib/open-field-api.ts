import { call } from "@/lib/frappe";
import type { OpenFieldGroup } from "@/lib/open-field";
import type { DraftPayload } from "@/lib/spray-plan-creator-api";

const M = "upande_scp.serverscripts.spray_plan_creator.open_field";

export interface BlockFinding {
  name: string;
  count: number;
  last_seen: string | null;
}
export interface BlockFindings {
  pests: BlockFinding[];
  diseases: BlockFinding[];
  /** pest and disease names, most seen first */
  targets: string[];
}

export interface BatchResult {
  results: Array<{ block: string; work_order: string; warnings: string[] }>;
}

/** The blocks the user may plan on, grouped by pivot or section. `crop` keeps one crop's blocks. */
export const fetchOpenFieldBlocks = (crop?: string) =>
  call<{ groups: OpenFieldGroup[] }>(`${M}.get_open_field_blocks`, crop ? { crop } : {});

export const fetchBlockFindings = (blocks: string[], days = 30) =>
  call<Record<string, BlockFindings>>(`${M}.get_block_findings`, {
    blocks: JSON.stringify(blocks),
    days,
  });

/** One draft per block, all or nothing; a failure names the block. */
export const createDraftPlansBatch = (plans: DraftPayload[]) =>
  call<BatchResult>(`${M}.create_draft_plans_batch`, { plans: JSON.stringify(plans) });
