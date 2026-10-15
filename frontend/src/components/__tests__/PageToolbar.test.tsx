import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PageToolbar } from "@/components/PageToolbar";
import { TogglePill } from "@/components/TogglePill";
import { ClearFiltersPill } from "@/components/ClearFiltersPill";
import { ToolbarButton } from "@/components/ToolbarButton";
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
    expect(screen.getByText("filters").closest('[data-slot="right"]')!.className).toContain("ml-auto");
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

describe("PageToolbar per-tab filters", () => {
  const filters = [
    { key: "date", tabs: ["pending"], node: <span>Spray date</span> },
    { key: "farm", node: <span>All farms</span> },
    { key: "step", tabs: ["approved"], node: <span>All steps</span> },
  ];
  const wrap = (text: string) => screen.getByText(text).closest("[data-filter]") as HTMLElement;

  it("hides filters that do not apply to the active tab, with a transition", () => {
    const { rerender } = render(
      <PageToolbar left={<span>tabs</span>} filters={filters} tab="pending" />,
    );
    expect(wrap("Spray date")).toHaveAttribute("data-state", "shown");
    expect(wrap("All steps")).toHaveAttribute("data-state", "hidden");
    expect(wrap("All steps").className).toContain("max-w-0");
    expect(wrap("All steps").className).toContain("opacity-0");
    expect(wrap("All steps").className).toContain("transition-all");
    expect(wrap("All steps").className).toContain("motion-reduce:transition-none");
    expect(wrap("All steps")).toHaveAttribute("aria-hidden", "true");
    rerender(<PageToolbar left={<span>tabs</span>} filters={filters} tab="approved" />);
    expect(wrap("Spray date")).toHaveAttribute("data-state", "hidden");
    expect(wrap("All steps")).toHaveAttribute("data-state", "shown");
    expect(wrap("All farms")).toHaveAttribute("data-state", "shown");
  });

  it("keeps hidden filters mounted so their state survives", () => {
    render(<PageToolbar filters={filters} tab="approved" />);
    expect(screen.getByText("Spray date")).toBeInTheDocument();
  });

  it("puts tabs, filters and actions in one row, right group after the tabs", () => {
    render(
      <PageToolbar left={<span>tabs</span>} filters={filters} tab="pending">
        <button>Refresh</button>
      </PageToolbar>,
    );
    const row = screen.getByTestId("page-toolbar");
    const right = row.querySelector('[data-slot="right"]') as HTMLElement;
    expect(row.children).toHaveLength(2);
    expect(right).toContainElement(screen.getByText("Spray date"));
    expect(right).toContainElement(screen.getByText("Refresh"));
    expect(right.className).toContain("ml-auto");
  });
});

describe("ToolbarButton", () => {
  it("is the same pill as the dropdowns", () => {
    render(<ToolbarButton>New cycle</ToolbarButton>);
    const b = screen.getByRole("button", { name: "New cycle" });
    pillClasses.forEach((c) => expect(b.className).toContain(c));
    expect(b.className).toContain("rounded-full");
  });
});

describe("ClearFiltersPill", () => {
  it("is hidden when nothing is active", () => {
    const { container } = render(<ClearFiltersPill active={false} onClear={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is a pill with red text, border and faint background, always", () => {
    const onClear = vi.fn();
    render(<ClearFiltersPill active onClear={onClear} />);
    const b = screen.getByRole("button", { name: "Clear" });
    expect(b.className).toContain("rounded-full");
    expect(b.className).toContain("h-9");
    expect(b.className).toContain("text-destructive");
    expect(b.className).toContain("border-destructive/40");
    expect(b.className).toContain("bg-destructive/10");
    expect(b.className).not.toContain("bg-card");
    expect(b.className).not.toContain("underline");
    expect(b).toHaveAttribute("type", "button");
    fireEvent.click(b);
    expect(onClear).toHaveBeenCalled();
  });
});
