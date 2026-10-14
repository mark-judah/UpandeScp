/**
 * Live spray check for the Application Floor Plan. Debounced on the plan's
 * greenhouse, targets (pests/diseases), product list and spray time; editing a
 * rate does not re-check. The server decides, this only fetches the decision
 * and derives the save gate from it.
 */
import { useEffect, useMemo, useState } from "react";
import {
  checkSprayPlan,
  eligibleProducts,
  saveGate,
  type CheckResult,
  type OverrideInput,
  type ProductEligibility,
} from "@/lib/spray-compliance-api";

export function useSprayCompliance(args: {
  greenhouse: string;
  targets: string[];
  items: string[];
  when?: string;
  excludeWo?: string;
  /** chemicals with their assigned pests / diseases; re-checks when a pick changes */
  rows?: { item: string; targets: string[] }[];
}) {
  const { greenhouse, targets, items, when, excludeWo, rows } = args;
  const rowsKey = JSON.stringify(rows ?? []);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [productInfo, setProductInfo] = useState<Record<string, ProductEligibility>>({});
  const [pendingOverrides, setPendingOverrides] = useState<OverrideInput[] | null>(null);
  const targetsKey = targets.join("\u0001");
  const itemsKey = items.join("\u0001");

  useEffect(() => {
    if (!greenhouse || !targets.length || !items.length) {
      setCheck(null);
      setProductInfo({});
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      // Settled separately: per-product details failing must not drop the check,
      // which gates the save.
      Promise.allSettled([
        checkSprayPlan({ greenhouse, targets, items, when, excludeWo, rows }),
        eligibleProducts({ greenhouse, targets, items: [], candidates: items, when }),
      ]).then(([r, info]) => {
        if (cancelled) return;
        setCheck(r.status === "fulfilled" ? r.value : null);
        setProductInfo(
          info.status === "fulfilled" ? Object.fromEntries(info.value.map((p) => [p.item, p])) : {},
        );
        setLoading(false);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [greenhouse, targetsKey, itemsKey, when, excludeWo, rowsKey]);

  // An override answers one particular check; a new check needs a new one.
  useEffect(() => {
    setPendingOverrides(null);
  }, [check]);

  const gate = useMemo(() => saveGate(check), [check]);

  /** Items named by a violation that has not been overridden. */
  const flaggedItems = useMemo(() => {
    const out = new Set<string>();
    for (const v of check?.violations ?? []) if (!v.overridden) v.products.forEach((i) => out.add(i));
    return out;
  }, [check]);

  return { check, loading, productInfo, gate, flaggedItems, pendingOverrides, setPendingOverrides };
}
