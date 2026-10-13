import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/scouting-api", () => ({ fetchBedsAndZones: () => Promise.resolve([]) }));
const { FindingViewer } = await import("../FindingViewer");
const { ZoomPan } = await import("../ZoomPan");

const photo = { image: "/private/files/a.jpg", subject: "Thrips", kind: "pest", entry: "E1", greenhouse: "GH1 - KR", bed: "4", zone: "GH1 - KR - Bed 4 - Zone 2" } as never;
const props = { photo, tab: "photo" as const, onTab: vi.fn(), onClose: vi.fn(), onPrev: vi.fn(), onNext: vi.fn(), canPrev: true, canNext: true };

describe("ZoomPan", () => {
  const rect = { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) };
  function setup() {
    render(<ZoomPan><div>x</div></ZoomPan>);
    const box = screen.getByTestId("zoom-pan");
    box.getBoundingClientRect = () => rect as DOMRect;
    return box;
  }
  it("zooms with the wheel, limits at 8x, and resets", () => {
    const box = setup();
    fireEvent.wheel(box, { deltaY: -300, clientX: 200, clientY: 150 });
    expect(Number(box.getAttribute("data-scale"))).toBeGreaterThan(1);
    for (let i = 0; i < 30; i++) fireEvent.wheel(box, { deltaY: -500, clientX: 10, clientY: 10 });
    expect(box.getAttribute("data-scale")).toBe("8.00");
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    expect(box.getAttribute("data-scale")).toBe("1.00");
  });
  it("double-click toggles 2.5x and 1x; the buttons step", () => {
    const box = setup();
    fireEvent.doubleClick(box, { clientX: 100, clientY: 100 });
    expect(box.getAttribute("data-scale")).toBe("2.50");
    fireEvent.doubleClick(box, { clientX: 100, clientY: 100 });
    expect(box.getAttribute("data-scale")).toBe("1.00");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(box.getAttribute("data-scale")).toBe("1.50");
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(box.getAttribute("data-scale")).toBe("1.00");
  });
});

describe("FindingViewer", () => {
  it("opens on the Photo tab with the 1600 thumb, swaps to the original past 2x", () => {
    render(<FindingViewer {...props} />);
    const img = screen.getByTestId("viewer-image");
    expect(img.getAttribute("src")).toContain("&w=1600");
    fireEvent.doubleClick(screen.getByTestId("viewer-photo")); // 2.5x
    expect(screen.getByTestId("viewer-image").getAttribute("src")).toBe("/private/files/a.jpg");
  });
  it("fits the whole photo in the stage at 1x", () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
    try {
      render(<FindingViewer {...props} />);
      const img = screen.getByTestId("viewer-image") as HTMLImageElement;
      Object.defineProperty(img, "naturalWidth", { value: 1600 });
      Object.defineProperty(img, "naturalHeight", { value: 2400 });
      fireEvent.load(img);
      // portrait photo: height-bound, 600 / 2400 = 0.25
      expect(img.style.width).toBe("400px");
      expect(img.style.height).toBe("600px");
      expect(screen.getByTestId("viewer-photo").getAttribute("data-scale")).toBe("1.00");
    } finally {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    }
  });
  it("zooms out below fit, not further than 0.5x", () => {
    render(<FindingViewer {...props} />);
    const box = screen.getByTestId("viewer-photo");
    box.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(box.getAttribute("data-scale")).toBe("0.50");
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    expect(box.getAttribute("data-scale")).toBe("1.00");
  });
  it("tabs, stepping and close buttons call back", () => {
    render(<FindingViewer {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: "Location" }));
    expect(props.onTab).toHaveBeenCalledWith("location");
    fireEvent.click(screen.getByRole("button", { name: "Next finding" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous finding" }));
    fireEvent.click(screen.getByRole("button", { name: "Close viewer" }));
    expect(props.onNext).toHaveBeenCalled();
    expect(props.onPrev).toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
  });
  it("Location tab captions the place", () => {
    render(<FindingViewer {...props} tab="location" />);
    expect(screen.getByTestId("viewer-caption")).toHaveTextContent("GH1 · Bed 4 · Zone 2");
  });
});
