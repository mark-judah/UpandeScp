import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DotCarousel, swipeTarget } from "./DotCarousel";

const slides = (n: number) => Array.from({ length: n }, (_, i) => <span key={i}>slide {i + 1}</span>);
const offset = (c: HTMLElement) =>
  (c.querySelector('[style*="translateX"]') as HTMLElement).style.transform;

describe("DotCarousel", () => {
  it("dots jump to a slide; chevrons and arrow keys step", () => {
    render(<DotCarousel>{slides(3)}</DotCarousel>);
    const root = screen.getByTestId("dot-carousel");
    expect(offset(root)).toBe("translateX(-0%)");
    fireEvent.click(screen.getByRole("button", { name: "Slide 3" }));
    expect(offset(root)).toBe("translateX(-200%)");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(offset(root)).toBe("translateX(-100%)");
    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(offset(root)).toBe("translateX(-200%)");
    fireEvent.keyDown(root, { key: "ArrowRight" }); // clamped at the end
    expect(offset(root)).toBe("translateX(-200%)");
    fireEvent.keyDown(root, { key: "ArrowLeft" });
    expect(offset(root)).toBe("translateX(-100%)");
  });

  it("swipes on touch", () => {
    render(<DotCarousel>{slides(3)}</DotCarousel>);
    const root = screen.getByTestId("dot-carousel");
    fireEvent.touchStart(root, { touches: [{ clientX: 200 }] });
    fireEvent.touchEnd(root, { changedTouches: [{ clientX: 100 }] });
    expect(offset(root)).toBe("translateX(-100%)");
    expect(swipeTarget(1, 3, 10)).toBe(1); // too short
    expect(swipeTarget(0, 3, 90)).toBe(0); // clamped
  });

  it("shows '3 / 14' instead of dots past ten slides, none for one", () => {
    const { rerender } = render(<DotCarousel>{slides(14)}</DotCarousel>);
    expect(screen.queryByTestId("carousel-dots")).toBeNull();
    expect(screen.getByTestId("carousel-counter")).toHaveTextContent("1 / 14");
    fireEvent.keyDown(screen.getByTestId("dot-carousel"), { key: "ArrowRight" });
    expect(screen.getByTestId("carousel-counter")).toHaveTextContent("2 / 14");
    rerender(<DotCarousel>{slides(10)}</DotCarousel>);
    expect(screen.getByTestId("carousel-dots").children).toHaveLength(10);
    rerender(<DotCarousel>{slides(1)}</DotCarousel>);
    expect(screen.queryByTestId("carousel-dots")).toBeNull();
  });
});
