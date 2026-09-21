/**
 * The floating sidebar variant.
 *
 * `floating` detaches the rail into its own rounded panel with a gap around
 * it, instead of sitting flush against the window edge. Two things have to
 * hold for that to read as detached rather than broken:
 *
 *   1. the outer box becomes a transparent spacer and gives up its border, so
 *      the page background shows through the gap — leaving the border on draws
 *      a line down the middle of that gap;
 *   2. the outer box is wider than the rail by the padding it adds, or the
 *      panel is squeezed narrower than the icons it holds every time the
 *      sidebar collapses.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Sidebar, SidebarProvider } from "@/components/ui/sidebar";

function renderSidebar(props: Record<string, unknown> = {}) {
  render(
    <SidebarProvider>
      <Sidebar {...props}>
        <div data-testid="rail-content">nav</div>
      </Sidebar>
    </SidebarProvider>,
  );
  return screen.getByTestId("rail-content");
}

/** The element carrying the variant, i.e. the outer spacer. */
function outerOf(content: HTMLElement): HTMLElement {
  const el = content.closest("[data-variant]");
  if (!el) throw new Error("no element carrying data-variant");
  return el as HTMLElement;
}

describe("Sidebar floating variant", () => {
  it("wraps the rail in its own panel and drops the flush border", () => {
    const outer = outerOf(renderSidebar({ variant: "floating" }));

    expect(outer.className).toContain("bg-transparent");
    expect(outer.className).not.toContain("border-r");

    const panel = outer.firstElementChild as HTMLElement;
    expect(panel.className).toContain("rounded-xl");
    expect(panel.className).toContain("border");
    expect(panel.className).toContain("bg-sidebar");
  });

  it("widens itself by the gap it adds, so the rail keeps its own width", () => {
    const outer = outerOf(renderSidebar({ variant: "floating" }));

    // padding on both sides == the 1rem added to each width
    expect(outer.className).toContain("p-2");
    expect(outer.className).toContain("w-[calc(var(--sidebar-width)+1rem)]");
  });

  it("leaves the default variant flush against the edge", () => {
    const outer = outerOf(renderSidebar());

    expect(outer.getAttribute("data-variant")).toBe("sidebar");
    expect(outer.className).toContain("border-r");
    expect(outer.className).toContain("bg-sidebar");
    expect(outer.className).not.toContain("bg-transparent");

    // no extra panel: the rail's content is a direct child
    expect(screen.getByTestId("rail-content").parentElement).toBe(outer);
  });
});
