import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DateRangePicker,
  formatRange,
  parseTypedDate,
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

  it("parses both typed formats and rejects impossible dates", () => {
    expect(parseTypedDate("05/10/2026")).toBe("2026-10-05");
    expect(parseTypedDate("5/10/2026")).toBe("2026-10-05");
    expect(parseTypedDate("2026-10-05")).toBe("2026-10-05");
    expect(parseTypedDate("31/02/2026")).toBeNull();
    expect(parseTypedDate("2026-13-01")).toBeNull();
    expect(parseTypedDate("tomorrow")).toBeNull();
  });

  it("commits typed dates, and flags invalid ones without committing", async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Harness spy={spy} />);
    await user.click(screen.getByRole("button", { name: "Range" }));
    const from = screen.getByLabelText("From date");
    const to = screen.getByLabelText("To date");

    await user.clear(from);
    await user.type(from, "40/01/2026{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(/dd\/mm\/yyyy/);
    expect(from).toHaveAttribute("aria-invalid", "true");
    expect(spy).not.toHaveBeenCalled();

    await user.clear(from);
    await user.type(from, "03/10/2026{Enter}");
    await user.clear(to);
    await user.type(to, "2026-10-09{Enter}");
    expect(spy).toHaveBeenLastCalledWith({ from: "2026-10-03", to: "2026-10-09" });
    expect(screen.getByRole("alert")).toHaveTextContent("");
  });

  it("swaps typed dates given in reverse order", async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Harness spy={spy} />);
    await user.click(screen.getByRole("button", { name: "Range" }));
    const from = screen.getByLabelText("From date");
    await user.clear(from);
    await user.type(from, "25/10/2026{Enter}");
    expect(spy).toHaveBeenLastCalledWith({ from: "2026-10-15", to: "2026-10-25" });
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

  it("respects min and max for clicks, typing and presets", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 15, 12) });
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Harness spy={spy} min="2026-10-05" max="2026-10-20" />);
    await user.click(screen.getByRole("button", { name: "Range" }));

    expect(day(/October 4th, 2026/)).toBeDisabled();
    expect(day(/October 21st, 2026/)).toBeDisabled();

    const from = screen.getByLabelText("From date");
    await user.clear(from);
    await user.type(from, "01/10/2026{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(/between/);
    expect(spy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Last month" }));
    expect(spy).toHaveBeenLastCalledWith({ from: "2026-10-05", to: "2026-10-05" });
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
