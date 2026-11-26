import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/open-field-api", () => ({
  fetchOpenFieldBlocks: vi.fn().mockResolvedValue({ groups: [] }),
  fetchBlockFindings: vi.fn().mockResolvedValue({}),
  createDraftPlansBatch: vi.fn(),
}));
vi.mock("@/lib/spray-plan-creator-api", () => ({
  fetchCreatorBootstrap: vi.fn().mockResolvedValue({ spray_teams: [], kits: [], tank_mixes: [], farm_stores: {}, pest_catalog: [], disease_catalog: [] }),
}));
vi.mock("@/components/spray-plan/DraftBatchPanel", () => ({ DraftBatchPanel: () => <div data-testid="drafts" /> }));

import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { ToastProvider } from "@/components/Toast";
import { OpenFieldPlanner } from "@/components/spray-plan/OpenFieldPlanner";

const KEY = "scp.hint.collapseSidebar.dismissed";

function Page({ open = true }: { open?: boolean }) {
  return (
    <ToastProvider>
      <SidebarProvider defaultOpen={open}>
        <AppSidebar crop="avocado" view="dashboard" onNavigate={() => {}} />
        <OpenFieldPlanner crop="Avocado" selected={[]} onSelect={() => {}} />
      </SidebarProvider>
    </ToastProvider>
  );
}

const hint = () => screen.queryByTestId("collapse-sidebar-hint");
const sidebarButton = () => screen.getByTitle(/(Collapse|Expand) sidebar/);

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("collapse-the-sidebar hint on the field planner", () => {
  it("shows while the sidebar is expanded and the hint was not dismissed", () => {
    render(<Page />);
    expect(hint()).toBeInTheDocument();
    expect(hint()).toHaveTextContent(/Collapse the sidebar/);
  });

  it("highlights the sidebar's Collapse button while it shows", () => {
    render(<Page />);
    const btn = sidebarButton();
    expect(btn).toHaveAttribute("data-highlight", "true");
    expect(btn.className).toMatch(/ring-2/);
    expect(btn.className).toMatch(/animate-pulse/);
  });

  it("Collapse sidebar collapses it and the hint goes", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(sidebarButton()).toHaveAttribute("title", "Expand sidebar");
    expect(hint()).toBeNull();
    expect(sidebarButton()).not.toHaveAttribute("data-highlight", "true");
  });

  it("Dismiss hides it and remembers that", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Page />);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(hint()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBe("1");
    expect(sidebarButton()).not.toHaveAttribute("data-highlight", "true");
    unmount();
    render(<Page />);
    expect(hint()).toBeNull();
  });

  it("is not shown when the sidebar is already collapsed", () => {
    render(<Page open={false} />);
    expect(hint()).toBeNull();
  });

  it("renders nothing outside the app shell (no sidebar)", () => {
    render(
      <ToastProvider>
        <OpenFieldPlanner crop="Avocado" selected={[]} onSelect={() => {}} />
      </ToastProvider>,
    );
    expect(hint()).toBeNull();
  });
});
