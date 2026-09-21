/**
 * The edge collapse toggle, after Frappe v16's own sidebar.
 *
 * A small control pinned to the sidebar's outer margin — not a button parked
 * in the page header. Two things matter: it actually collapses and expands the
 * rail, and the chevron points the way the rail will move, so it reads as
 * "push this closed" rather than as decoration.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  Sidebar,
  SidebarEdgeToggle,
  SidebarProvider,
} from "@/components/ui/sidebar";

function setup() {
  render(
    <SidebarProvider>
      <Sidebar variant="floating">
        <SidebarEdgeToggle />
        <div data-testid="rail-content">nav</div>
      </Sidebar>
    </SidebarProvider>,
  );
  const content = screen.getByTestId("rail-content");
  const outer = content.closest("[data-variant]") as HTMLElement;
  return { outer, toggle: screen.getByRole("button", { name: /sidebar/i }) };
}

describe("SidebarEdgeToggle", () => {
  it("collapses and re-expands the rail", async () => {
    const user = userEvent.setup();
    const { outer, toggle } = setup();

    expect(outer.getAttribute("data-state")).toBe("expanded");

    await user.click(toggle);
    expect(outer.getAttribute("data-state")).toBe("collapsed");

    await user.click(toggle);
    expect(outer.getAttribute("data-state")).toBe("expanded");
  });

  it("points the chevron the way the rail will move", async () => {
    const user = userEvent.setup();
    const { toggle } = setup();

    // Expanded: pushing it closed moves the rail left.
    expect(toggle.querySelector(".lucide-chevron-left")).not.toBeNull();

    await user.click(toggle);

    // Collapsed: pulling it open moves the rail right.
    expect(toggle.querySelector(".lucide-chevron-right")).not.toBeNull();
  });

  it("sits on the rail's edge rather than in the page flow", () => {
    const { toggle } = setup();
    expect(toggle.className).toContain("absolute");
  });
});
