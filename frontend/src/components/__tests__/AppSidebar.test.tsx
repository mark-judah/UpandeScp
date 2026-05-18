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

function renderSidebar() {
  return render(
    <SidebarProvider>
      <AppSidebar view="dashboard" onNavigate={() => {}} />
    </SidebarProvider>,
  );
}

describe("AppSidebar role-gated items", () => {
  beforeEach(() => clearRoles());
  afterEach(() => clearRoles());

  it("hides Access Control for users without General Manager", () => {
    withRoles(["Spray Plan Creator"]);
    renderSidebar();
    expect(screen.queryByText("Access Control")).toBeNull();
  });

  it("shows Access Control for General Managers", () => {
    withRoles(["General Manager"]);
    renderSidebar();
    expect(screen.getByText("Access Control")).toBeInTheDocument();
  });

  it("shows Access Control for System Managers", () => {
    withRoles(["System Manager"]);
    renderSidebar();
    expect(screen.getByText("Access Control")).toBeInTheDocument();
  });
});
