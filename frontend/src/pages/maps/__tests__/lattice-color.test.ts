import { describe, expect, it } from "vitest";
import { parseColor } from "../FieldLatticeLayer";

describe("parseColor", () => {
  it("reads the tone bands' rgba strings, alpha included", () => {
    expect(parseColor("rgba(51,102,204,0.55)")).toEqual([51, 102, 204, 0.55]);
  });
  it("reads hex as opaque", () => {
    expect(parseColor("#3366cc")).toEqual([51, 102, 204, 1]);
    expect(parseColor("#36c")).toEqual([51, 102, 204, 1]);
  });
});
