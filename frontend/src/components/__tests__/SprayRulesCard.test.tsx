import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/spray-compliance-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spray-compliance-api")>()),
  getRuleModes: vi.fn(async () => ({
    crop: "",
    rules: [{ rule: "target_match", mode: "Warn", default: "Warn", overridden: false }],
    modes: ["Off", "Warn", "Block (GM override)", "Block"],
  })),
  getTargetingMode: vi.fn(async () => ({ mode: "Warn", modes: ["Strict", "Warn"], can_edit: true })),
  setTargetingMode: vi.fn(async (m: string) => ({ mode: m, modes: ["Strict", "Warn"], can_edit: true })),
}));

const { SprayRulesCard } = await import("@/components/settings/SprayRulesCard");

describe("SprayRulesCard targeting mode", () => {
  it("explains both modes in one sentence each and shows the current one", async () => {
    render(<SprayRulesCard />);
    await waitFor(() => expect(screen.getByTestId("targeting-mode")).toBeInTheDocument());
    const box = screen.getByTestId("targeting-mode");
    expect(box).toHaveTextContent("Strict: every chemical must be assigned a pest or disease it is registered or known to work on");
    expect(box).toHaveTextContent("Warn: any chemical may be picked");
    expect(screen.getByLabelText("Chemical targeting enforcement")).toHaveTextContent("Warn");
  });

  it("is not shown on a crop's own card", async () => {
    render(<SprayRulesCard crop="Rose" />);
    await waitFor(() => expect(screen.getByText(/Spray check rules/)).toBeInTheDocument());
    expect(screen.queryByTestId("targeting-mode")).toBeNull();
  });
});
