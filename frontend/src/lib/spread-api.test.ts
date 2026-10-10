import { beforeEach, describe, expect, it, vi } from "vitest";

const call = vi.fn();
vi.mock("./frappe", () => ({ call: (...a: unknown[]) => call(...a) }));

import { NO_CLUSTERS, getHouseClusters, isoWeekKey, patchLine, pinValueLabel, savePin } from "./spread-api";

beforeEach(() => {
  call.mockReset().mockResolvedValue({ name: "PIN-1" });
});

describe("spread api", () => {
  it("pads the ISO week the server keys on", () => {
    expect(isoWeekKey("2031-W5")).toBe("2031-W05");
    expect(isoWeekKey("2031-W31")).toBe("2031-W31");
    expect(isoWeekKey(null)).toBeUndefined();
  });

  it("sends stations and the polygon as JSON, shared and notify as 0/1", async () => {
    await savePin({
      crop: "Rose", warehouse: "GH", kind: "Area", title: "corner", shared: false,
      polygon: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    });
    const [method, args] = call.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe("upande_scp.serverscripts.scouting.pins.save_pin");
    expect(JSON.parse(args.polygon as string).type).toBe("Polygon");
    expect([args.shared, args.notify]).toEqual([0, 1]);
    await savePin({ crop: "Rose", warehouse: "GH", kind: "Patch", title: "p", stations: ["Z1", "Z2"] });
    expect((call.mock.calls[1][1] as Record<string, unknown>).stations).toBe('["Z1","Z2"]');
  });

  it("falls back to no clusters and pads the week it asks for", async () => {
    call.mockResolvedValueOnce(null);
    const got = await getHouseClusters({ crop: "Rose", warehouse: "GH", observation: "Thrips", kind: "pest", week: "2031-W5" });
    expect(got).toEqual(NO_CLUSTERS);
    expect((call.mock.calls[0][1] as Record<string, unknown>).week).toBe("2031-W05");
  });

  it("words a pin's figure and a patch", () => {
    expect(pinValueLabel(undefined)).toBe("not scouted");
    expect(pinValueLabel({ week: "2031-W31", scouted: 4, infested: 4, value: null, thin: true })).toBe("too few scouted");
    expect(pinValueLabel({ week: "2031-W31", scouted: 6, infested: 3, value: 50, thin: false })).toBe("50%");
    expect(patchLine({ size: 9, label: "beds 1–3, zones 1–3" }, "bed")).toBe("9 zones · beds 1–3, zones 1–3");
    expect(patchLine({ size: 4, label: "rows 1–2, trees 1–2" }, "row")).toBe("4 trees · rows 1–2, trees 1–2");
  });
});
