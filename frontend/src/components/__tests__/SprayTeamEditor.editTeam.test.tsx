import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SprayTeam } from "@/lib/teams-api";
import type { CreatorSprayTeam } from "@/lib/spray-plan-creator-api";

// Radix Select needs these in jsdom.
beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

const MASTER: SprayTeam = {
  name: "CSU 1",
  team_name: "CSU 1",
  enabled: 1,
  farm: "Chepsito",
  members: [
    { employee: "KR-001", employee_name: "Alice Chebet", designation: "Applicator", role: "Sprayer", image: "/files/alice.jpg" },
    { employee: "KR-002", employee_name: "Bob Kiprop", designation: "Supervisor", role: "Supervisor" },
  ],
};
const CREATOR_TEAMS: CreatorSprayTeam[] = [
  { name: "CSU 1", custom_farm: "Chepsito", members: MASTER.members.map((m) => ({ ...m })) },
  { name: "CSU 9", custom_farm: "Kapkolia", members: [] },
];

let manageable: SprayTeam[] = [MASTER];
const fetchMock = vi.fn(async () => manageable);
const saveMock = vi.fn();
const searchMock = vi.fn(async () => [
  { employee: "KR-003", employee_name: "Carol Jeptoo", designation: "Applicator", image: null },
]);

vi.mock("@/lib/teams-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/teams-api")>()),
  fetchSprayTeams: (...a: unknown[]) => fetchMock(...(a as [])),
  saveSprayTeam: (...a: unknown[]) => saveMock(...a),
  searchEmployees: (...a: unknown[]) => searchMock(...(a as [])),
}));
vi.mock("@/lib/spray-plan-creator-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spray-plan-creator-api")>()),
  searchEmployees: async () => [],
}));

const { SprayTeamEditor, rosterMatches } = await import("@/components/spray-plan/SprayTeamEditor");
type Row = import("@/components/spray-plan/SprayTeamEditor").TeamMemberRow;

const seed = (): Row[] =>
  MASTER.members.map((m) => ({
    employee: m.employee, employee_name: m.employee_name, designation: m.designation, role: m.role,
  }));

let latest: Row[] = [];
function Harness({ initialTeam = "CSU 1", initialMembers = seed() }: { initialTeam?: string; initialMembers?: Row[] }) {
  const [team, setTeam] = useState(initialTeam);
  const [members, setMembers] = useState<Row[]>(initialMembers);
  latest = members;
  return (
    <SprayTeamEditor
      teams={CREATOR_TEAMS}
      team={team}
      onTeamChange={setTeam}
      members={members}
      onMembersChange={setMembers}
      crop="Rose"
    />
  );
}

const savedWith = (members: { employee: string; role: string }[]): SprayTeam => ({
  ...MASTER,
  members: members.map((m) => ({
    employee: m.employee,
    employee_name: m.employee === "KR-003" ? "Carol Jeptoo" : MASTER.members.find((x) => x.employee === m.employee)!.employee_name,
    role: m.role as SprayTeam["members"][number]["role"],
  })),
});

async function editAndSave() {
  await userEvent.click(await screen.findByRole("button", { name: /edit team/i }));
  const dialog = await screen.findByRole("dialog");
  // remove Bob, add Carol, make Alice a pump operator
  await userEvent.click(within(dialog).getByRole("button", { name: "Remove Bob Kiprop" }));
  await userEvent.type(within(dialog).getByLabelText("Add member"), "Car");
  await userEvent.click(await within(dialog).findByRole("option", { name: /Carol Jeptoo/ }));
  await userEvent.click(within(dialog).getByRole("combobox", { name: "Role of Alice Chebet" }));
  await userEvent.click(await screen.findByRole("option", { name: "Pump Operator" }));
  await userEvent.click(within(dialog).getByRole("button", { name: /save to team/i }));
  return dialog;
}

describe("Application Plan ▸ Edit team (master team)", () => {
  beforeEach(() => {
    manageable = [MASTER];
    fetchMock.mockClear();
    saveMock.mockReset();
    saveMock.mockImplementation(async (_t: string, patch: { members: { employee: string; role: string }[] }) =>
      savedWith(patch.members),
    );
    searchMock.mockClear();
  });

  it("shows the button only for a team the user can manage", async () => {
    const { unmount } = render(<Harness />);
    expect(await screen.findByRole("button", { name: /edit team/i })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledWith("Rose");
    unmount();

    // a team on a farm the user cannot manage → no button
    render(<Harness initialTeam="CSU 9" initialMembers={[]} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: /edit team/i })).toBeNull();
  });

  it("no rights at all (server refuses) → no button", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("You do not have access to spray teams.");
    });
    render(<Harness />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /edit team/i })).toBeNull();
  });

  it("disabled until a team is picked", async () => {
    render(<Harness initialTeam="" initialMembers={[]} />);
    expect(await screen.findByRole("button", { name: /edit team/i })).toBeDisabled();
  });

  it("adds, removes and re-roles, saves through save_spray_team, and re-seeds an untouched roster", async () => {
    render(<Harness />);
    await editAndSave();
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const [team, patch, crop] = saveMock.mock.calls[0];
    expect(team).toBe("CSU 1");
    expect(crop).toBe("Rose");
    expect(patch.members).toEqual([
      { employee: "KR-001", role: "Pump Operator" },
      { employee: "KR-003", role: "Sprayer" },
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // plan roster matched the old master → re-seeded from the saved team
    expect(latest.map((m) => [m.employee, m.role])).toEqual([
      ["KR-001", "Pump Operator"],
      ["KR-003", "Sprayer"],
    ]);
    expect(screen.queryByText(/Use the updated team for this plan/)).toBeNull();
  });

  it("keeps a customised plan roster and offers the updated team", async () => {
    const custom = seed().slice(0, 1); // the operator dropped Bob from this plan
    render(<Harness initialMembers={custom} />);
    await editAndSave();
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const use = await screen.findByRole("button", { name: /Use the updated team for this plan/ });
    expect(latest.map((m) => m.employee)).toEqual(["KR-001"]);
    await userEvent.click(use);
    expect(latest.map((m) => m.employee)).toEqual(["KR-001", "KR-003"]);
    expect(screen.queryByRole("button", { name: /Use the updated team/ })).toBeNull();
  });

  it("a server error is shown in the modal and the edits are kept", async () => {
    saveMock.mockImplementationOnce(async () => {
      throw new Error("Employee KR-003 is not in Karen Roses.");
    });
    render(<Harness />);
    const dialog = await editAndSave();
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Employee KR-003 is not in Karen Roses.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(dialog).getByText("Carol Jeptoo")).toBeInTheDocument();
    expect(within(dialog).queryByText("Bob Kiprop")).toBeNull();
    expect(within(dialog).getByRole("button", { name: /save to team/i })).toBeEnabled();
    // the plan roster is untouched
    expect(latest.map((m) => m.employee)).toEqual(["KR-001", "KR-002"]);
  });

  it("rosterMatches ignores order but not roles", () => {
    const a = [{ employee: "A", role: "Sprayer" }, { employee: "B", role: "Supervisor" }];
    expect(rosterMatches([...a].reverse(), a)).toBe(true);
    expect(rosterMatches([{ employee: "A", role: "Supervisor" }, a[1]], a)).toBe(false);
    expect(rosterMatches(a.slice(0, 1), a)).toBe(false);
  });

  it("the member editor shows the Employee photo, initials only as fallback", async () => {
    render(<Harness />);
    await userEvent.click(await screen.findByRole("button", { name: /edit team/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Changes apply to CSU 1 for all future plans/)).toBeInTheDocument();
    expect(dialog.querySelector('img[src="/files/alice.jpg"]')).not.toBeNull();
    expect(within(dialog).getByText("BK")).toBeInTheDocument();
    expect(dialog.innerHTML).not.toMatch(/border-l-|border-left/);
  });
});
