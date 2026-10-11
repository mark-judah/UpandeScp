import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

const availMock = vi.fn(async (args: { employees?: string[]; on_date?: string }) => ({
  mode: "Block",
  require_checkin: false,
  on_date: args.on_date,
  members: {
    "KR-001": { status: "on_leave", label: "On leave", half_day: false, leave_application: "HR-LAP-1", leave_type: "Annual Leave", employee_name: "Alice" },
    "KR-002": { status: "leave_pending", label: "Leave pending", half_day: false, leave_application: "HR-LAP-2", leave_type: null, employee_name: "Bob" },
    "KR-003": { status: "ok", label: "Available", half_day: false, leave_application: null, leave_type: null, employee_name: "Carol" },
  },
}));

vi.mock("@/lib/schedule-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/schedule-api")>()),
  fetchCrewAvailability: (a: { employees?: string[]; on_date?: string }) => availMock(a),
}));
vi.mock("@/lib/teams-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/teams-api")>()),
  fetchSprayTeams: async () => [],
}));

const { SprayTeamEditor } = await import("@/components/spray-plan/SprayTeamEditor");

const MEMBERS = [
  { employee: "KR-001", employee_name: "Alice", role: "Sprayer" },
  { employee: "KR-002", employee_name: "Bob", role: "Supervisor" },
  { employee: "KR-003", employee_name: "Carol", role: "Sprayer" },
];

describe("SprayTeamEditor crew badges", () => {
  it("shows a badge per unavailable member for the plan date", async () => {
    render(
      <SprayTeamEditor
        teams={[]}
        team=""
        onTeamChange={() => {}}
        members={MEMBERS}
        onMembersChange={() => {}}
        onDate="2026-09-03"
      />,
    );
    await waitFor(() => expect(screen.getAllByTestId("crew-badge")).toHaveLength(2));
    expect(availMock).toHaveBeenCalledWith(
      expect.objectContaining({ on_date: "2026-09-03", employees: ["KR-001", "KR-002", "KR-003"] }),
    );
    const statuses = screen.getAllByTestId("crew-badge").map((b) => b.getAttribute("data-status"));
    expect(statuses.sort()).toEqual(["leave_pending", "on_leave"]);
    expect(screen.getByText("On leave")).toBeTruthy();
    expect(screen.getByText(/2 unavailable on 2026-09-03/)).toBeTruthy();
  });

  it("asks nothing without a plan date", async () => {
    availMock.mockClear();
    render(
      <SprayTeamEditor teams={[]} team="" onTeamChange={() => {}} members={MEMBERS} onMembersChange={() => {}} />,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(availMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("crew-badge")).toBeNull();
  });
});
