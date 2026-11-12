import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const checkMock = vi.fn(async () => ({
  mode: "Warn",
  ok: true,
  errors: [],
  warnings: [],
  supervisors: [
    { employee: "E1", employee_name: "Alice", status: "ok", message: "" },
    { employee: "E2", employee_name: "Bob", status: "missing_role", message: "Bob lacks the role" },
  ],
}));
vi.mock("@/lib/spray-plan-creator-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/spray-plan-creator-api")>()),
  checkSprayTeam: () => checkMock(),
}));

const { SupervisorBanner } = await import("@/components/spray-plan/SupervisorBanner");
const { teamRuleError } = await import("@/lib/spray-plan-creator-api");

describe("SupervisorBanner", () => {
  it("names each supervisor with the role-check result", async () => {
    render(
      <SupervisorBanner
        team="T"
        members={[
          { employee: "E1", employee_name: "Alice", role: "Supervisor" },
          { employee: "E2", employee_name: "Bob", role: "Supervisor" },
          { employee: "E3", employee_name: "Cy", role: "Sprayer" },
        ]}
      />,
    );
    expect(screen.getByText(/takes charge of all spray operations/i)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Role assigned")).toBeTruthy());
    expect(screen.getByText("Missing Spray Supervisor role")).toBeTruthy();
    expect(screen.queryByText("Cy")).toBeNull();
  });

  it("says so when no supervisor is chosen", () => {
    render(<SupervisorBanner team="T" members={[{ employee: "E3", role: "Sprayer" }]} />);
    expect(screen.getByText(/No supervisor chosen yet/)).toBeTruthy();
  });
});

describe("teamRuleError", () => {
  const m = (role: string, i = 1) => ({ employee: `E${i}`, role });
  it("blocks empty, no supervisor, three supervisors; allows one or two", () => {
    expect(teamRuleError([])).toMatch(/no members/);
    expect(teamRuleError([m("Sprayer")])).toMatch(/no spray supervisor/);
    expect(teamRuleError([m("Supervisor", 1), m("Supervisor", 2), m("Supervisor", 3)])).toMatch(/at most 2/);
    expect(teamRuleError([m("Supervisor", 1), m("Supervisor", 2)])).toBeNull();
    expect(teamRuleError([m("Supervisor")])).toBeNull();
  });
});
