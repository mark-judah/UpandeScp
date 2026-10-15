import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DateRangePicker,
  formatRange,
  type DateRange,
  type DateRangePickerProps,
} from "@/components/DateRangePicker";

function Harness(props: Partial<DateRangePickerProps> & { initial?: DateRange; spy?: (r: DateRange) => void }) {
  const [v, setV] = useState<DateRange>(props.initial ?? { from: "2026-10-01", to: "2026-10-15" });
  return (
    <DateRangePicker
      label="Range"
      {...props}
      value={v}
      onChange={(r) => {
        setV(r);
        props.spy?.(r);
      }}
    />
  );
}

const day = (name: RegExp) => screen.getByRole("button", { name });

afterEach(() => vi.useRealTimers());

describe("DateRangePicker", () => {
  it("shows the range compactly on the pill", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Range" })).toHaveTextContent("1 – 15 Oct 2026");
    expect(formatRange({ from: "2026-09-28", to: "2026-10-03" })).toBe("28 Sep – 3 Oct 2026");
    expect(formatRange({ from: "2025-12-30", to: "2026-01-02" })).toBe("30 Dec 2025 – 2 Jan 2026");
    expect(formatRange({ from: "2026-10-05", to: "2026-10-05" })).toBe("5 Oct 2026");
  });

  it("first click sets the start, second sets the end, then closes", async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Harness spy={spy} />);
    await user.click(screen.getByRole("button", { name: "Range" }));
    await user.click(day(/October 6th, 2026/));
    expect(spy).not.toHaveBeenCalled();
    await user.click(day(/October 20th, 2026/));
    expect(spy).toHaveBeenCalledWith({ from: "2026-10-06", to: "2026-10-20" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("swaps when the second click is earlier", async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Harness spy={spy} />);
    await user.click(screen.getByRole("button", { name: "Range" }));
    await user.click(day(/October 20th, 2026/));
    await user.click(day(/October 6th, 2026/));
    expect(spy).toHaveBeenCalledWith({ from: "2026-10-06", to: "2026-10-20" });
  });

  it("allowSingleDay=false ignores a second click on the same day", async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Harness spy={spy} allowSingleDay={false} />);
    await user.click(screen.getByRole("button", { name: "Range" }));
    await user.click(day(/October 6th, 2026/));
    await user.click(day(/October 6th, 2026/));
    expect(spy).not.toHaveBeenCalled();
    await user.click(day(/October 7th, 2026/));
    expect(spy).toHaveBeenCalledWith({ from: "2026-10-06", to: "2026-10-07" });
  });

  it("applies presets against today and via custom presets", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 15, 12) }); // Thu 15 Oct 2026
    const spy = vi.fn();
    const user = userEvent.setup();
    render(
      <Harness
        spy={spy}
        presets={[{ label: "Season", range: () => ({ from: "2026-07-01", to: "2026-09-30" }) }]}
      />,
    );
    const open = async () => user.click(screen.getByRole("button", { name: "Range" }));
    const cases: [string, DateRange][] = [
      ["Today", { from: "2026-10-15", to: "2026-10-15" }],
      ["Yesterday", { from: "2026-10-14", to: "2026-10-14" }],
      ["This week", { from: "2026-10-12", to: "2026-10-18" }],
      ["Last 7 days", { from: "2026-10-09", to: "2026-10-15" }],
      ["Last 14 days", { from: "2026-10-02", to: "2026-10-15" }],
      ["This month", { from: "2026-10-01", to: "2026-10-31" }],
      ["Last month", { from: "2026-09-01", to: "2026-09-30" }],
      ["Season", { from: "2026-07-01", to: "2026-09-30" }],
    ];
    for (const [name, want] of cases) {
      await open();
      await user.click(screen.getByRole("button", { name }));
      expect(spy).toHaveBeenLastCalledWith(want);
    }
  });

  it("respects min and max for clicks and presets", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 15, 12) });
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Harness spy={spy} min="2026-10-05" max="2026-10-20" />);
    await user.click(screen.getByRole("button", { name: "Range" }));

    expect(day(/October 4th, 2026/)).toBeDisabled();
    expect(day(/October 21st, 2026/)).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Last month" }));
    expect(spy).toHaveBeenLastCalledWith({ from: "2026-10-05", to: "2026-10-05" });
  });

  it("has no typed From/To fields; the choice reads back as labels", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Range" }));
    expect(screen.queryByLabelText("From date")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("To date")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    const readout = screen.getByTestId("range-readout");
    expect(readout).toHaveTextContent("From 1 Oct 2026 · To 15 Oct 2026");
    await user.click(day(/October 6th, 2026/));
    expect(readout).toHaveTextContent("From 6 Oct 2026 · To pick the end day");
  });

  it("zooms out to months and years, so June to August takes a few clicks", async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Harness spy={spy} initial={{ from: "2026-10-01", to: "2026-10-15" }} />);
    await user.click(screen.getByRole("button", { name: "Range" }));
    await user.click(screen.getAllByRole("button", { name: "Choose month or year" })[0]);
    expect(screen.getByTestId("month-view")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "June 2026" }));
    await user.click(day(/June 3rd, 2026/));
    // zoom out again and jump to August
    await user.click(screen.getAllByRole("button", { name: "Choose month or year" })[0]);
    await user.click(screen.getByRole("button", { name: "August 2026" }));
    await user.click(day(/August 28th, 2026/));
    expect(spy).toHaveBeenCalledWith({ from: "2026-06-03", to: "2026-08-28" });
  });

  it("the year list jumps across years", async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Harness spy={spy} />);
    await user.click(screen.getByRole("button", { name: "Range" }));
    await user.click(screen.getAllByRole("button", { name: "Choose month or year" })[0]);
    await user.click(screen.getByRole("button", { name: "Choose year" }));
    expect(screen.getByTestId("year-view")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Year 2024" }));
    await user.click(screen.getByRole("button", { name: "March 2024" }));
    await user.click(day(/March 5th, 2024/));
    await user.click(day(/March 9th, 2024/));
    expect(spy).toHaveBeenCalledWith({ from: "2024-03-05", to: "2024-03-09" });
  });

  it("disables months and years outside min/max in the zoomed views", async () => {
    const user = userEvent.setup();
    render(<Harness min="2026-08-10" max="2027-02-20" initial={{ from: "2026-10-01", to: "2026-10-15" }} />);
    await user.click(screen.getByRole("button", { name: "Range" }));
    await user.click(screen.getAllByRole("button", { name: "Choose month or year" })[0]);
    expect(screen.getByRole("button", { name: "July 2026" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "August 2026" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Choose year" }));
    expect(screen.getByRole("button", { name: "Year 2025" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Year 2027" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Year 2016" })).toBeDisabled();
  });

  it("selected days are high-contrast and range days soft-tinted (classes)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Range" }));
    const startCell = day(/October 1st, 2026/).closest("td")!;
    const midCell = day(/October 7th, 2026/).closest("td")!;
    expect(startCell.className).toMatch(/bg-foreground\b/);
    expect(startCell.className).toMatch(/\[&>button\]:text-background/);
    expect(startCell.className).not.toMatch(/text-primary-foreground/);
    expect(midCell.className).toMatch(/bg-foreground\/10/);
    expect(midCell.className).toMatch(/\[&>button\]:text-foreground/);
  });

  it("respects prefers-reduced-motion in the stylesheet", () => {
    const css = readFileSync(join(__dirname, "..", "..", "index.css"), "utf8");
    const block = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    for (const c of [".scp-cal-fill", ".scp-cal-pop", ".scp-cal-slide", ".scp-cal-zoom"]) {
      expect(block).toContain(c);
    }
    expect(block).toMatch(/animation: none/);
  });

  it("Escape closes the popover without changing the value", async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Harness spy={spy} />);
    await user.click(screen.getByRole("button", { name: "Range" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(day(/October 6th, 2026/));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Range" })).toHaveTextContent("1 – 15 Oct 2026");
  });

  it("selects by keyboard: arrows move, Enter picks", async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Harness spy={spy} />);
    await user.click(screen.getByRole("button", { name: "Range" }));
    day(/October 6th, 2026/).focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowRight}{ArrowRight}{Enter}");
    expect(spy).toHaveBeenCalledWith({ from: "2026-10-06", to: "2026-10-08" });
  });

  it("does not open when disabled", async () => {
    const user = userEvent.setup();
    render(<Harness disabled />);
    await user.click(screen.getByRole("button", { name: "Range" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
