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

  it("shows the rose nav (Rose Scouting) for the rose crop", () => {
    withRoles(["General Manager"]);
    renderSidebar("rose");
    expect(screen.getByText("Rose Scouting")).toBeInTheDocument();
    expect(screen.queryByText("Job Sheets")).toBeNull();
  });

  it("shows the avocado nav (Job Sheets) for the avocado crop", () => {
    withRoles(["General Manager"]);
    renderSidebar("avocado");
    expect(screen.getByText("Job Sheets")).toBeInTheDocument();
    expect(screen.queryByText("Rose Scouting")).toBeNull();
  });

  it("falls back to a generic scouting nav for an unknown crop", () => {
    withRoles(["General Manager"]);
    renderSidebar("macadamia");
    expect(screen.getByText("Scouting Map")).toBeInTheDocument();
    // No crop-specific extras (job sheets / application plan) for a new crop.
    expect(screen.queryByText("Job Sheets")).toBeNull();
  });
});
