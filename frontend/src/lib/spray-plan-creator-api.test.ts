import { beforeEach, describe, expect, it, vi } from "vitest";

const call = vi.fn();
vi.mock("./frappe", () => ({ call: (...a: unknown[]) => call(...a) }));

import { fetchCreatorBootstrap } from "./spray-plan-creator-api";

const METHOD = "upande_scp.serverscripts.spray_plan_creator.bootstrap.fetch_creator_bootstrap";

beforeEach(() => call.mockReset().mockResolvedValue({}));

describe("fetchCreatorBootstrap", () => {
  it("sends the route crop", async () => {
    await fetchCreatorBootstrap("Avocado");
    expect(call).toHaveBeenCalledWith(METHOD, { crop: "Avocado" });
  });

  it("sends nothing when there is no crop (old behaviour)", async () => {
    await fetchCreatorBootstrap();
    expect(call).toHaveBeenCalledWith(METHOD, {});
  });
});
