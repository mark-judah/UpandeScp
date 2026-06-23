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

  it("shows the rose nav (Crop Protection section) for the rose crop", () => {
    withRoles(["General Manager"]);
    renderSidebar("rose");
    // Rose nav has a dedicated Crop Protection section with Application Plan and Approvals.
    expect(screen.getByText("Application Plan")).toBeInTheDocument();
    expect(screen.getByText("Approvals")).toBeInTheDocument();
    // Rose nav uses "Scouting" as the item label, not "Scouting Map".
    expect(screen.queryByText("Scouting Map")).toBeNull();
  });

  it("falls back to a generic scouting nav for an unknown crop", () => {
    withRoles(["General Manager"]);
    renderSidebar("macadamia");
    expect(screen.getByText("Scouting Map")).toBeInTheDocument();
    // No crop-specific extras (application plan / approvals) for a new crop.
    expect(screen.queryByText("Application Plan")).toBeNull();
    expect(screen.queryByText("Approvals")).toBeNull();
  });
});
