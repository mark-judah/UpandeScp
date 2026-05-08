export type TreeNode = {
  id: string;
  label: string;
  count?: number;
  children?: TreeNode[];
};

/** Picked items from the Stations tree. A farm selection means "aggregate
 * across this farm's greenhouses"; a station selection is a specific
 * greenhouse/block. */
export type Selection =
  | { kind: "farm"; farm: string; label: string }
  | { kind: "station"; farm: string; station: string; label: string };

export type ObsKey = { kind: "pest" | "disease"; name: string; label: string };

export type CheckState = "checked" | "indeterminate" | "unchecked";
