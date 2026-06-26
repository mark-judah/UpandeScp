import { describe, it, expect } from "vitest";
import { filterTeamsByFarm } from "@/lib/spray-team-filter";

const teams = [
  { name: "Team A", custom_farm: "Main" },
  { name: "Team B", custom_farm: "" },
  { name: "Team C", custom_farm: null as string | null },
  { name: "Team D", custom_farm: "Main" },
  { name: "Team X", custom_farm: "Other" },
];

describe("filterTeamsByFarm", () => {
  it("keeps farm-matching and unfarmed teams, hides other-farm", () => {
    const out = filterTeamsByFarm(teams, "Main").map((t) => t.name);
    expect(out).toEqual(["Team A", "Team B", "Team C", "Team D"]);
  });

  it("is case-insensitive on the farm name", () => {
    const out = filterTeamsByFarm(teams, "main").map((t) => t.name);
    expect(out).toContain("Team A");
    expect(out).not.toContain("Team X");
  });

  it("shows all teams when no farm is selected", () => {
    expect(filterTeamsByFarm(teams, "").length).toBe(teams.length);
  });
});
