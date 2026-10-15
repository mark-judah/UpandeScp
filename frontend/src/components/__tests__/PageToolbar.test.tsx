import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PageToolbar } from "@/components/PageToolbar";
import { TogglePill } from "@/components/TogglePill";
import { ClearFiltersPill } from "@/components/ClearFiltersPill";
import { HEADER_PILL } from "@/components/header-controls";

const pillClasses = HEADER_PILL.split(" ");

describe("PageToolbar", () => {
  it("renders both slots inside one row container", () => {
    render(
      <PageToolbar left={<span>tabs</span>}>
        <span>filters</span>
      </PageToolbar>,
    );
    const row = screen.getByTestId("page-toolbar");
    expect(row).toContainElement(screen.getByText("tabs"));
    expect(row).toContainElement(screen.getByText("filters"));
    expect(row.className).toContain("flex-wrap");
  });

  it("right-aligns filters when there is no left slot", () => {
    render(
      <PageToolbar>
        <span>filters</span>
      </PageToolbar>,
    );
    expect(screen.getByText("filters").parentElement!.className).toContain("ml-auto");
  });
});

describe("TogglePill", () => {
  it("shares the FilterSelect pill classes and reports aria-pressed", () => {
    const onChange = vi.fn();
    render(
      <TogglePill pressed={false} onPressedChange={onChange}>
        Group by farm
      </TogglePill>,
    );
    const b = screen.getByRole("button", { name: "Group by farm" });
    pillClasses.forEach((c) => expect(b.className).toContain(c));
    expect(b).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(b);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("shows the on-state as pressed", () => {
    render(<TogglePill pressed>Group by farm</TogglePill>);
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("ClearFiltersPill", () => {
  it("is hidden when nothing is active", () => {
    const { container } = render(<ClearFiltersPill active={false} onClear={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is a red-accent pill that clears", () => {
    const onClear = vi.fn();
    render(<ClearFiltersPill active onClear={onClear} />);
    const b = screen.getByRole("button", { name: "Clear" });
    expect(b.className).toContain("text-destructive");
    // Clear is narrower than a dropdown, so it overrides min-width and border colour only.
    pillClasses.filter((c) => !c.startsWith("min-w") && !c.startsWith("border")).forEach((c) => expect(b.className).toContain(c));
    fireEvent.click(b);
    expect(onClear).toHaveBeenCalled();
  });
});
