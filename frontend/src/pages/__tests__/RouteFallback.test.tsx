import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const { PageFallback, ApplicationPlanSkeleton, routeHeading } = await import("@/App");

describe("route fallback (skeleton spec K5)", () => {
  it("titles a loading page from the sidebar's own nav metadata", () => {
    render(<PageFallback crop="rose" view="procurement" />);
    expect(screen.getByRole("heading", { name: "Procurement" })).toBeInTheDocument();
    expect(screen.getByText("Crop Protection")).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("uses the crop's label: the avocado Jobsheet is the heatmaps route", () => {
    expect(routeHeading("avocado", "heatmaps")).toEqual({ title: "Jobsheet", eyebrow: "Crop Protection" });
    expect(routeHeading("rose", "sprayers")).toEqual({ title: "Sprayers", eyebrow: "Personnel" });
  });

  it("draws a map silhouette under the real header for map views", () => {
    render(<PageFallback crop="rose" view="observations" />);
    expect(screen.getByRole("heading", { name: "Observations" })).toBeInTheDocument();
    expect(screen.getByLabelText("Loading the map")).toBeInTheDocument();
  });

  it("a view no sidebar lists is still titled, never anonymous", () => {
    render(<PageFallback crop="rose" view="notifications" />);
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeInTheDocument();
  });

  it("the Application Plan skeleton carries the page's own header and steps", () => {
    render(<ApplicationPlanSkeleton />);
    expect(screen.getByRole("heading", { name: "New Application Floor Plan" })).toBeInTheDocument();
    expect(screen.getByText("Diagnose · Prescribe · Submit for approval")).toBeInTheDocument();
    expect(screen.getByText("Diagnose")).toBeInTheDocument();
    expect(screen.getByText("Prescribe")).toBeInTheDocument();
  });
});
