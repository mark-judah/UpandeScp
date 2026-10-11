import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SprayersPayload, SprayTeam, SprayerDetail } from "@/lib/teams-api";

const TEAMS: SprayTeam[] = [
  {
    name: "CHEPSITO CSU 1",
    team_name: "CHEPSITO CSU 1",
    enabled: 1,
    farm: "Chepsito",
    members: [
      { employee: "KR-001", employee_name: "Alice Chebet", designation: "Spray Applicator", role: "Sprayer", sprayer: "SPR-00001" },
      { employee: "KR-002", employee_name: "Bob Kiprop", designation: "Spray Supervisor", role: "Supervisor", sprayer: "SPR-00002" },
    ],
  },
];

const SPRAYERS: SprayersPayload = {
  sprayers: [
    {
      name: "SPR-00001", employee: "KR-001", employee_name: "Alice Chebet", farm: "Chepsito",
      spray_team: "CHEPSITO CSU 1", role: "Sprayer", status: "Active",
      hours_30d: 2, weighted_30d: 8, hours_total: 10, weighted_total: 30, last_exposure: "2026-10-01",
    },
    {
      name: "SPR-00002", employee: "KR-002", employee_name: "Bob Kiprop", farm: "Chepsito",
      spray_team: "CHEPSITO CSU 1", role: "Supervisor", status: "Active",
      hours_30d: 5, weighted_30d: 5, hours_total: 50, weighted_total: 60, last_exposure: "2026-10-02",
    },
  ],
  flags: { rows: 40, no_duration: 3, hazard_unknown: 12, products_unclassified: 4 },
};

const DETAIL: SprayerDetail = {
  sprayer: SPRAYERS.sprayers[0],
  products: [
    { spray_product: "1110009", product_name: "IMPULSE EC500", toxicity: "II", hazard_weight: 3, sessions: 2, hours: 2, weighted_hours: 6, last_date: "2026-10-01" },
    { spray_product: null, product_name: "Mystery Mix", toxicity: null, hazard_weight: 2, sessions: 1, hours: 1, weighted_hours: 2, last_date: "2026-09-01" },
  ],
  sessions: [
    { logsheet: "SAL-2026-0001", date: "2026-10-01", greenhouse: "Chepsito GH 01 - KR", role: "Sprayer", ppe_condition: "Good", hours: 1, weighted_hours: 3, products: "IMPULSE EC500", flags: null },
  ],
};

const saveMock = vi.fn(async (_team: string, patch: { members?: { employee: string; role: string }[] }) => ({
  ...TEAMS[0],
  members: (patch.members || []).map((m) => ({ employee: m.employee, employee_name: m.employee, role: m.role })),
}));
const searchMock = vi.fn(async () => [
  { employee: "KR-003", employee_name: "Carol Jeptoo", designation: "Spray Applicator" },
]);
const detailMock = vi.fn(async () => DETAIL);

vi.mock("@/lib/teams-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/teams-api")>()),
  fetchTeamsContext: async () => ({ manager: true, farms: ["Chepsito", "Kapkolia"] }),
  fetchSprayTeams: async () => TEAMS,
  fetchSprayers: async () => SPRAYERS,
  fetchSprayerDetail: (...a: unknown[]) => detailMock(...(a as [])),
  searchEmployees: (...a: unknown[]) => searchMock(...(a as [])),
  saveSprayTeam: (...a: unknown[]) => saveMock(...(a as [string, { members?: { employee: string; role: string }[] }])),
}));

const { Teams } = await import("@/pages/Teams");
const { Sprayers } = await import("@/pages/Sprayers");

describe("Personnel ▸ Teams and Sprayers", () => {
  beforeEach(() => {
    saveMock.mockClear();
    searchMock.mockClear();
    detailMock.mockClear();
  });

  it("Teams is the spray team page only", async () => {
    render(<Teams initialCrop="Rose" />);
    expect(screen.getByRole("heading", { name: "Teams" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Alice Chebet")).toBeInTheDocument());
    expect(screen.queryByRole("tab", { name: "Scouting KPIs" })).toBeNull();
  });

  it("edits a team: remove one, add one, save sends the new roster", async () => {
    render(<Teams initialCrop="Rose" />);
    const card = await screen.findByTestId("team-CHEPSITO CSU 1");
    const save = within(card).getByRole("button", { name: /save team/i });
    expect(save).toBeDisabled();

    await userEvent.click(within(card).getByRole("button", { name: "Remove Bob Kiprop" }));
    await userEvent.type(within(card).getByLabelText("Add member"), "Car");
    const option = await within(card).findByRole("option", { name: /Carol Jeptoo/ });
    expect(searchMock).toHaveBeenCalledWith("Chepsito", "Car", "Rose");
    await userEvent.click(option);
    expect(save).toBeEnabled();
    await userEvent.click(save);

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [team, patch] = saveMock.mock.calls[0];
    expect(team).toBe("CHEPSITO CSU 1");
    expect(patch.members).toEqual([
      { employee: "KR-001", role: "Sprayer" },
      { employee: "KR-003", role: "Sprayer" },
    ]);
  });

  it("All sprayers: the register sorted by weighted 30d, sortable, searchable, with flag counts", async () => {
    render(<Sprayers initialCrop="Rose" />);
    await userEvent.click(await screen.findByRole("tab", { name: "All sprayers" }));
    const table = await screen.findByRole("table", { name: "Sprayers" });
    let rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("SPR-00001")).toBeInTheDocument();

    await userEvent.click(within(table).getByRole("button", { name: /Hours total/ }));
    rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("SPR-00002")).toBeInTheDocument();

    expect(screen.getByText(/rows with no duration/)).toBeInTheDocument();
    expect(screen.getByText(/products lack a hazard class/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Search sprayers"), "bob");
    rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
  });

  it("Records: list beside a portrait record with exposure per product and recent sprays", async () => {
    render(<Sprayers initialCrop="Rose" />);
    const record = await screen.findByTestId("sprayer-record");
    // opens on the top of the list (highest weighted 30d)
    expect(within(record).getAllByText("Alice Chebet").length).toBeGreaterThan(0);
    await waitFor(() => expect(detailMock).toHaveBeenCalledWith("SPR-00001", "Rose"));
    const products = await screen.findByRole("table", { name: "Exposure per product" });
    expect(within(products).getByText("IMPULSE EC500")).toBeInTheDocument();
    expect(within(products).getByText("Class II")).toBeInTheDocument();
    expect(within(products).getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText(/Chepsito GH 01 - KR/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Exposure" })).toBeInTheDocument();
    // initials stand in for the missing photo
    expect(screen.getByLabelText("Alice Chebet — no photograph")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("person-SPR-00002"));
    await waitFor(() => expect(detailMock).toHaveBeenCalledWith("SPR-00002", "Rose"));

    await userEvent.click(screen.getByRole("button", { name: /Compare against the farm/ }));
    expect(await screen.findByRole("table", { name: "Comparison figures" })).toBeInTheDocument();
  });

  it("a row of All sprayers opens that person's record", async () => {
    render(<Sprayers initialCrop="Rose" />);
    await userEvent.click(await screen.findByRole("tab", { name: "All sprayers" }));
    await userEvent.click(await screen.findByTestId("sprayer-SPR-00002"));
    const record = await screen.findByTestId("sprayer-record");
    expect(within(record).getAllByText("Bob Kiprop").length).toBeGreaterThan(0);
  });

  it("draws no left-border accent strips", async () => {
    const { container } = render(<Sprayers initialCrop="Rose" />);
    await screen.findByTestId("sprayer-record");
    expect(container.innerHTML).not.toMatch(/border-l-|border-left/);
  });
});
