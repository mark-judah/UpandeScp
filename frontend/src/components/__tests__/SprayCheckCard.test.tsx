import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SprayCheckCard } from "@/components/spray-plan/SprayCheckCard";
import type { CheckResult } from "@/lib/spray-compliance-api";

const failed: CheckResult = {
  status: "Check failed", message: "The spray check could not run for this plan.",
  violations: [], coverage: [], blocking: true, needs_override: false, can_override: false,
};

describe("SprayCheckCard", () => {
  it("says the check could not run instead of claiming the plan passes", () => {
    render(<SprayCheckCard result={failed} loading={false} names={{}} />);
    expect(screen.getByText("The spray check could not run for this plan.")).toBeTruthy();
    expect(screen.queryByText(/All checks pass/)).toBeNull();
  });
  it("still says a clean plan passes", () => {
    render(<SprayCheckCard result={{ ...failed, status: "Clean", message: undefined, blocking: false }} loading={false} names={{}} />);
    expect(screen.getByText(/All checks pass/)).toBeTruthy();
  });
});
