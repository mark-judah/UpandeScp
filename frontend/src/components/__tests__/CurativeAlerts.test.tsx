import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CurativeAlerts } from "@/components/spray-plan/CurativeAlerts";
import type { CreatorAlert } from "@/lib/scouting-alerts-api";

const alert: CreatorAlert = {
  name: "SA-1", warehouse: "Chepsito GH 01 - KR", observation: "Thrips", stage: "", action: "Spray advised",
  value: 33.3, unit: "%", reliability: "Fair", iso_week: "2031-W20", status: "Open",
  margin: 18, sections_scouted: 9, sections_total: 9,
};

describe("CurativeAlerts", () => {
  it("shows the server's action and figure and starts a curative plan", async () => {
    const onCreate = vi.fn();
    render(<CurativeAlerts alerts={[alert]} onCreate={onCreate} />);
    expect(screen.getByTestId("alert-action")).toHaveTextContent("Spray advised");
    expect(screen.getByText("33.3% · ±18 · 9/9")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create curative plan" }));
    expect(onCreate).toHaveBeenCalledWith(alert);
  });

  it("marks the alert the plan is being made for", () => {
    render(<CurativeAlerts alerts={[alert]} activeAlert="SA-1" onCreate={() => {}} />);
    expect(screen.getByRole("button", { name: "In this plan" })).toBeInTheDocument();
  });

  it("says plainly when no spray threshold is crossed", () => {
    render(<CurativeAlerts alerts={[]} onCreate={() => {}} />);
    expect(screen.getByTestId("no-curative-alerts")).toHaveTextContent(
      "No spray threshold crossed in the latest scouted week.",
    );
  });
});
