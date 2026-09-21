/**
 * The circular header action and its description tooltip.
 *
 * A round button with a single glyph says nothing about itself. `title` gives
 * the browser's own tooltip, which is slow to appear, unstyled, and invisible
 * to touch — so the glyph stays a guess. `tooltip` renders a real one that can
 * carry a sentence, and the button keeps an accessible name either way.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { RefreshCw } from "lucide-react";

import { HeaderIconButton } from "@/components/header-controls";

describe("HeaderIconButton", () => {
  it("is a circle holding the glyph, with an accessible name", () => {
    render(
      <HeaderIconButton aria-label="Reload">
        <RefreshCw />
      </HeaderIconButton>,
    );
    const btn = screen.getByRole("button", { name: "Reload" });
    expect(btn.className).toContain("rounded-full");
  });

  it("describes itself on hover when given a tooltip", async () => {
    const user = userEvent.setup();
    render(
      <HeaderIconButton aria-label="Reload" tooltip="Fetch the latest scouting data">
        <RefreshCw />
      </HeaderIconButton>,
    );

    expect(
      screen.queryAllByText("Fetch the latest scouting data"),
    ).toHaveLength(0);

    await user.hover(screen.getByRole("button", { name: "Reload" }));

    // Radix renders the description twice — the visible bubble and a
    // visually-hidden copy that screen readers announce — so both are expected.
    const shown = await screen.findAllByText("Fetch the latest scouting data");
    expect(shown.length).toBeGreaterThan(0);
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
  });

  it("needs no tooltip provider from the caller", () => {
    // Rendered bare, with no TooltipProvider anywhere above it. Radix throws
    // if one is missing, so reaching the assertion is the assertion.
    render(
      <HeaderIconButton aria-label="Thresholds" tooltip="Set alert thresholds">
        <RefreshCw />
      </HeaderIconButton>,
    );
    expect(screen.getByRole("button", { name: "Thresholds" })).toBeInTheDocument();
  });

  it("stays a plain button when no tooltip is given", async () => {
    const user = userEvent.setup();
    render(
      <HeaderIconButton aria-label="Reload">
        <RefreshCw />
      </HeaderIconButton>,
    );
    await user.hover(screen.getByRole("button", { name: "Reload" }));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
