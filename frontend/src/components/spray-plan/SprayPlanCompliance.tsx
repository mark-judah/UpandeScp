/**
 * Spray compliance block for the Application Floor Plan: the pest -> product
 * mapping (which chosen product covers which target), every rule the mix
 * breaks, and the GM override flow. Pure presentation over `useSprayCompliance`.
 *
 * The pest -> product mapping shown here is what gets saved on the plan: the
 * targets in `Work Order.custom_targets` and the products in the Work Order's
 * required items; Finance reads them from there.
 */
import { useState } from "react";
import { SprayCheckCard } from "@/components/spray-plan/SprayCheckCard";
import { OverrideDialog } from "@/components/spray-plan/OverrideDialog";
import type { useSprayCompliance } from "@/lib/use-spray-compliance";
import type { OverrideInput } from "@/lib/spray-compliance-api";

type Compliance = ReturnType<typeof useSprayCompliance>;

export function SprayPlanCompliance({
  compliance,
  names,
  onOverrideConfirm,
}: {
  compliance: Compliance;
  /** item_code -> display name. */
  names: Record<string, string>;
  /** Called with the GM's reasons; the page then saves the plan with them. */
  onOverrideConfirm: (o: OverrideInput[]) => void;
}) {
  const { check, loading, gate, setPendingOverrides } = compliance;
  const [open, setOpen] = useState(false);
  return (
    <>
      <SprayCheckCard
        result={check}
        loading={loading}
        names={names}
        onOverride={gate.state === "override" && check?.can_override ? () => setOpen(true) : undefined}
      />
      <OverrideDialog
        open={open}
        onOpenChange={setOpen}
        violations={check?.violations ?? []}
        onConfirm={(o) => {
          setPendingOverrides(o);
          setOpen(false);
          onOverrideConfirm(o);
        }}
      />
    </>
  );
}
