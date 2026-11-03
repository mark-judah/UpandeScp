import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRoute } from "../router";

describe("retired routes", () => {
  it("the open-field Spray Plan link lands on the Application Plan and the address bar says so", () => {
    window.location.hash = "#/potato/open-field-plan";
    const { result } = renderHook(() => useRoute());
    expect(result.current[0]).toEqual({ crop: "potato", view: "application-plan" });
    expect(window.location.hash).toBe("#/potato/application-plan");
  });
});
