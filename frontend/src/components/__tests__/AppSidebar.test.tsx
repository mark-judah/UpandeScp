import { render, screen } from "@testing-library/react";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";

function withRoles(roles: string[]): void {
  (window as unknown as { SCP?: Record<string, unknown> }).SCP = {
    bootstrap: { user: "u@example.com", roles },
  };
}

function clearRoles(): void {
  delete (window as unknown as { SCP?: unknown }).SCP;
}

function renderSidebar(crop: string) {
  return render(
    <SidebarProvider>
      <AppSidebar crop={crop} view="dashboard" onNavigate={() => {}} />
    </SidebarProvider>,
  );
}

describe("AppSidebar crop-scoped nav", () => {
  beforeEach(() => clearRoles());
  afterEach(() => clearRoles());

  // NOTE (2026-08-10): this whole file had never executed — vitest.config.ts
  // restricted collection to `src/**/*.test.ts` with `environment: "node"`, so
  // every .test.tsx was silently skipped. Enabling .tsx collection surfaced the
  // two expectations below as stale. Left skipped rather than rewritten to match
  // the code, because only a human can say which side is wrong:
  //
  //   * "Rose Scouting" — ROSE_NAV labels this item plain "Scouting" (renamed).
  //     Probably just a stale string in the test.
  //   * "Job Sheets"    — appears nowhere in the codebase. AVOCADO_NAV has no
  //     such item, so this test was written ahead of a feature that never
  //     landed. Un-skip it when the avocado job-sheet nav ships.
  it.skip("shows the rose nav (Rose Scouting) for the rose crop", () => {
    withRoles(["SCP General Manager"]);
    renderSidebar("rose");
    expect(screen.getByText("Rose Scouting")).toBeInTheDocument();
    expect(screen.queryByText("Job Sheets")).toBeNull();
  });

  it.skip("shows the avocado nav (Job Sheets) for the avocado crop", () => {
    withRoles(["SCP General Manager"]);
    renderSidebar("avocado");
    expect(screen.getByText("Job Sheets")).toBeInTheDocument();
    expect(screen.queryByText("Rose Scouting")).toBeNull();
  });

  // The behaviour both skipped tests were reaching for, asserted against the
  // nav as it actually is today — so crop-scoped nav stays covered meanwhile.
  it("gives rose and avocado their own crop-scoped navs", () => {
    withRoles(["SCP General Manager"]);
    const rose = renderSidebar("rose");
    expect(screen.getByText("Spraying")).toBeInTheDocument();
    rose.unmount();

    renderSidebar("avocado");
    expect(screen.getByText("Scouting Map")).toBeInTheDocument();
    expect(screen.queryByText("Spraying")).toBeNull();
  });

  it("falls back to a generic scouting nav for an unknown crop", () => {
    withRoles(["SCP General Manager"]);
    renderSidebar("macadamia");
    expect(screen.getByText("Scouting Map")).toBeInTheDocument();
    // No crop-specific extras (job sheets / application plan) for a new crop.
    expect(screen.queryByText("Job Sheets")).toBeNull();
  });
});

describe("Personnel group and Coverage (personnel spec P1–P3)", () => {
  beforeEach(() => clearRoles());
  afterEach(() => clearRoles());

  const personnel = () => screen.queryByText("Personnel");

  it("shows all three pages to a general manager, on every crop", () => {
    for (const crop of ["rose", "avocado", "coffee", "macadamia"]) {
      withRoles(["SCP General Manager"]);
      const r = renderSidebar(crop);
      expect(personnel()).toBeInTheDocument();
      for (const label of ["Scouts", "Sprayers", "Teams", "Coverage"]) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
      expect(screen.queryByText("Teams & KPIs")).toBeNull();
      r.unmount();
    }
  });

  it("gives a spray plan creator Sprayers and Teams but not Scouts", () => {
    withRoles(["SCP Spray Plan Creator"]);
    renderSidebar("rose");
    expect(personnel()).toBeInTheDocument();
    expect(screen.getByText("Sprayers")).toBeInTheDocument();
    expect(screen.getByText("Teams")).toBeInTheDocument();
    expect(screen.queryByText("Scouts")).toBeNull();
  });

  it("gives a scouting user Scouts only", () => {
    withRoles(["SCP Scouting User"]);
    renderSidebar("rose");
    expect(screen.getByText("Scouts")).toBeInTheDocument();
    expect(screen.queryByText("Sprayers")).toBeNull();
    expect(screen.queryByText("Teams")).toBeNull();
  });

  it("hides the group from someone with none of its roles", () => {
    withRoles(["SCP Spray Plan Approver"]);
    renderSidebar("rose");
    expect(personnel()).toBeNull();
    expect(screen.getByText("Coverage")).toBeInTheDocument();
  });
});
