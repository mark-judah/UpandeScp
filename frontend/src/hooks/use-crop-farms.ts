import { useEffect, useState } from "react";
import { fetchFarmsAndWarehousesResult, type FarmsResult } from "@/lib/scouting-api";

export type CropFarms = FarmsResult & { loading: boolean };

/** The route crop's farm → warehouses map, narrowed on the server (spec D3).
 *  The server also applies the user's own scope, so nothing outside the crop
 *  ever reaches the page. An empty crop keeps the old unscoped list. */
export function useCropFarms(crop: string): CropFarms {
  const [state, setState] = useState<CropFarms>({ farms: {}, loading: true });
  useEffect(() => {
    let cancelled = false;
    setState({ farms: {}, loading: true });
    fetchFarmsAndWarehousesResult(crop || undefined).then((r) => {
      if (!cancelled) setState({ ...r, loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, [crop]);
  return state;
}
