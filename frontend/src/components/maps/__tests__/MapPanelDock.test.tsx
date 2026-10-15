import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MapControlPanel } from "../MapControlPanel";
import { MapFloatingCard } from "../MapFloatingCard";
import { MapPanelDock } from "../MapPanelDock";

describe("MapPanelDock", () => {
  it("anchors bottom-right on desktop and is a full-width bottom stack on a phone", () => {
    render(<MapPanelDock><p>x</p></MapPanelDock>);
    const c = screen.getByTestId("map-panel-dock").className;
    for (const k of ["absolute", "bottom-4", "right-4", "z-[1000]", "flex-col", "gap-2", "items-end", "max-h-[calc(100%-5rem)]",
      "max-sm:left-2", "max-sm:right-2", "max-sm:bottom-2", "max-sm:items-stretch", "max-sm:[&>*]:!w-full"]) {
      expect(c).toContain(k);
    }
    expect(c).not.toContain("left-3 ");
    expect(c).not.toContain(" top-");
  });

  it("stacks panels in the column in source order without self-positioning", () => {
    render(
      <MapPanelDock>
        <MapControlPanel title="Sprayers in view"><p>list</p></MapControlPanel>
        <MapFloatingCard title="GH 1" onClose={() => {}}><p>detail</p></MapFloatingCard>
      </MapPanelDock>,
    );
    const dock = screen.getByTestId("map-panel-dock");
    const panel = screen.getByTestId("map-control-panel");
    const card = screen.getByTestId("map-floating-card");
    expect(Array.from(dock.children)).toEqual([panel, card]);
    for (const el of [panel, card]) {
      expect(el.className).toContain("relative");
      expect(el.className).not.toContain("absolute");
    }
    expect(card.className).toContain("max-h-[min(60vh,32rem)]");
  });
});
