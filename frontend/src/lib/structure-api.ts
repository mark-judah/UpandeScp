/**
 * Farm structure: how a farm's nodes connect. Backend:
 * upande_scp.serverscripts.geo.farm_structure.get_farm_structure.
 */
import { call } from "./frappe";

export type UnitInfo = { kind: "Bed" | "Row" | "Hexa" | (string & {}); units: number; children: number; edge: number };

export type NodeCrop = {
  /** custom_crop set on the node itself */
  own: string | null;
  /** nearest custom_crop up the tree, and the label of the node it comes from */
  inherited: string | null;
  inherited_from: string | null;
  /** crop a live crop cycle gives, when it differs from the one above */
  cycle: string | null;
};

export type StructureNode = {
  name: string;
  label: string;
  /** "(no type)" when the node's type is blank */
  type: string;
  children: StructureNode[];
  unit: UnitInfo | null;
  flags: string[];
  /** absent on an older server */
  crop?: NodeCrop;
};

export type StructurePath = { types: string[]; stations: number };

export type FarmStructure = {
  farm: string;
  root: StructureNode | null;
  paths: StructurePath[];
  built_at: string;
  /** Standard triangle side for Hexa layouts, in metres (absent on an older server). */
  triad_side_m?: number;
  /** the caller may edit a node's crop (absent on an older server) */
  can_edit?: boolean;
  /** crops a node can be set to */
  crops?: string[];
};

export function fetchFarmStructure(farm: string, refresh = false): Promise<FarmStructure> {
  return call<FarmStructure>("upande_scp.serverscripts.geo.farm_structure.get_farm_structure", {
    farm,
    refresh: refresh ? 1 : 0,
  });
}

/** Set (or clear, with null) the crop on one structure node. */
export function setNodeCrop(node: string, crop: string | null): Promise<{ node: string; crop: string | null }> {
  return call("upande_scp.serverscripts.geo.farm_structure.set_node_crop", { node, crop: crop ?? "" });
}
