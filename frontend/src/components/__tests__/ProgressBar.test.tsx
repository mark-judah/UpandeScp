/**
 * The one property worth protecting: the bar never shows a number nobody measured.
 *
 * The loaders this replaces eased a *simulated* percentage toward 92% whenever the
 * real channel was quiet — which on the `/scp_app` shell was always, since it loads
 * no socket. So "indeterminate" has to be a real mode, and `null` has to be
 * distinguishable from `0`.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressBar } from "../ProgressBar";
import { LoadingOverlay } from "../LoadingOverlay";

describe("ProgressBar", () => {
  it("shows the figure when there is one", () => {
    render(<ProgressBar percent={42} label="loading pest rows" />);
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("loading pest rows")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  });

  it("shows NO figure when the percent is null", () => {
    render(<ProgressBar percent={null} />);
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).toHaveAttribute("aria-valuetext", "Loading");
  });

  it("distinguishes null from zero — 0% is a measurement, null is not", () => {
    const { unmount } = render(<ProgressBar percent={0} />);
    expect(screen.getByText("0%")).toBeInTheDocument();
    unmount();
    render(<ProgressBar percent={null} />);
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("sweeps rather than filling when indeterminate", () => {
    const { container } = render(<ProgressBar percent={null} />);
    expect(
      container.querySelector(".scp-progress__fill--indeterminate"),
    ).toBeTruthy();
  });

  it("fills to the percent, left to right", () => {
    const { container } = render(<ProgressBar percent={70} />);
    const fill = container.querySelector(".scp-progress__fill") as HTMLElement;
    expect(fill.style.width).toBe("70%");
    expect(fill.className).not.toContain("indeterminate");
  });

  it("clamps nonsense instead of overflowing the track", () => {
    const { container, unmount } = render(<ProgressBar percent={150} />);
    expect(
      (container.querySelector(".scp-progress__fill") as HTMLElement).style.width,
    ).toBe("100%");
    unmount();
    const second = render(<ProgressBar percent={-20} />);
    expect(
      (second.container.querySelector(".scp-progress__fill") as HTMLElement).style
        .width,
    ).toBe("0%");
  });
});

describe("LoadingOverlay", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<LoadingOverlay open={false} progress={50} />);
    expect(container.firstChild).toBeNull();
  });

  it("derives a real percent from the week counters when none was reported", () => {
    // The weeks were previously a caption beside a faked bar; they are a genuine
    // fraction, so they should drive it.
    render(<LoadingOverlay open weeksLoaded={3} weeksTotal={12} />);
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText("3 of 12 weeks")).toBeInTheDocument();
  });

  it("prefers a reported percent over the week fraction", () => {
    render(
      <LoadingOverlay open progress={80} weeksLoaded={1} weeksTotal={10} />,
    );
    expect(screen.getByText("80%")).toBeInTheDocument();
  });

  it("stays indeterminate when neither signal exists", () => {
    render(<LoadingOverlay open progress={null} />);
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
  });

  it("does not divide by zero when the total is unknown", () => {
    render(<LoadingOverlay open weeksLoaded={0} weeksTotal={0} />);
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });
});
