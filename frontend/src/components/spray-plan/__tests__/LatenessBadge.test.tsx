import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LatenessBadge } from "../LatenessBadge";

describe("LatenessBadge", () => {
  it("renders nothing for an on-time, unmoved plan", () => {
    const { container } = render(<LatenessBadge level="none" />);
    expect(container.firstChild).toBeNull();
  });
  it("names the grade", () => {
    render(<LatenessBadge level="orange" />);
    expect(screen.getByText("Late")).toBeTruthy();
  });
  it("falls back to the legacy missed flag", () => {
    render(<LatenessBadge missed />);
    expect(screen.getByText("Missed")).toBeTruthy();
  });
  it("shows a postponement with its original day", () => {
    render(<LatenessBadge postponed postponedFrom="2026-11-10 06:00:00" />);
    expect(screen.getByText(/Postponed from 2026-11-10/)).toBeTruthy();
  });
});
