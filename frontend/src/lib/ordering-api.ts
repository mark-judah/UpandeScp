import { call } from "./frappe";

export interface OrderingRow {
  row: string; // Pest Filter / Disease Filter doc name
  name: string; // pest / disease name
  priorities: Record<string, number>; // { plantSectionName: rank }
}

export interface OrderingBundle {
  crop: string;
  sections: string[]; // ordered plant-section columns
  pests: OrderingRow[];
  diseases: OrderingRow[];
}

export async function getPriorities(crop: string): Promise<OrderingBundle> {
  const r = await call<{ message?: OrderingBundle } | OrderingBundle>(
    "upande_scp.serverscripts.ordering_api.get_priorities",
    { crop },
  );
  return (
    ((r as { message?: OrderingBundle })?.message ?? (r as OrderingBundle)) || {
      crop,
      sections: [],
      pests: [],
      diseases: [],
    }
  );
}

export async function savePriorities(
  crop: string,
  payload: OrderingBundle,
): Promise<{ ok: boolean }> {
  const r = await call<{ message?: { ok: boolean } } | { ok: boolean }>(
    "upande_scp.serverscripts.ordering_api.save_priorities",
    { crop, payload: JSON.stringify(payload) },
  );
  return (
    ((r as { message?: { ok: boolean } })?.message ??
      (r as { ok: boolean })) || { ok: false }
  );
}
