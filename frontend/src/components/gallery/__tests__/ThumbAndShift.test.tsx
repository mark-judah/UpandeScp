import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThumbImg } from "../ThumbImg";
import { contentPadClass, PANEL_SHIFT } from "@/pages/Gallery";

describe("ThumbImg", () => {
  it("uses the 480 thumb with a 480/960 srcset, lazy and async", () => {
    render(<ThumbImg src="/files/p.jpg" width={480} sizes="50vw" alt="pest" />);
    const img = screen.getByAltText("pest") as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("thumbs.thumb?src=%2Ffiles%2Fp.jpg&w=480");
    expect(img.getAttribute("srcset")).toMatch(/w=480 480w, .*w=960 960w/);
    expect(img.getAttribute("sizes")).toBe("50vw");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
  });
  it("shows a placeholder until the image loads", () => {
    const { container } = render(<ThumbImg src="/files/p.jpg" alt="x" />);
    const box = container.firstElementChild as HTMLElement;
    expect(box.className).toContain("aspect-[4/3]");
    expect(box.getAttribute("data-loaded")).toBe("false");
    fireEvent.load(screen.getByAltText("x"));
    expect(box.getAttribute("data-loaded")).toBe("true");
    expect(box.className).not.toContain("aspect-[4/3]");
  });
  it("passes non-file sources through", () => {
    render(<ThumbImg src="https://x.test/a.jpg" alt="ext" />);
    const img = screen.getByAltText("ext");
    expect(img.getAttribute("src")).toBe("https://x.test/a.jpg");
    expect(img.getAttribute("srcset")).toBeNull();
  });
});

describe("panel shift", () => {
  it("adds md right padding only while the panel is open, always animated", () => {
    const open = contentPadClass(true);
    const closed = contentPadClass(false);
    expect(open).toContain(PANEL_SHIFT);
    expect(closed).not.toContain("md:pr-");
    for (const c of [open, closed]) {
      expect(c).toContain("duration-300");
      expect(c).toContain("motion-reduce:transition-none");
    }
  });
});
