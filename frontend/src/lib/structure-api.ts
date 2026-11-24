/**
 * Farm structure: how a farm's nodes connect. Backend:
 * upande_scp.serverscripts.geo.farm_structure.get_farm_structure.
 */
import { call } from "./frappe";

export type UnitInfo = { kind: "Bed" | "Row" | "Hexa" | (string & {}); units: number; children: number; edge: number };

export type StructureNode = {
  name: string;
  label: string;
  /** "(no type)" when the node's type is blank */
  type: string;
  children: StructureNode[];
  unit: UnitInfo | null;
  flags: string[];
};

export type StructurePath = { types: string[]; stations: number };

export type FarmStructure = {
  farm: string;
  root: StructureNode | null;
  paths: StructurePath[];
  built_at: string;
};

export function fetchFarmStructure(farm: string, refresh = false): Promise<FarmStructure> {
  return call<FarmStructure>("upande_scp.serverscripts.geo.farm_structure.get_farm_structure", {
    farm,
    refresh: refresh ? 1 : 0,
  });
}
