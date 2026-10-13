import { describe, expect, it } from "vitest";
import { isThumbable, thumbSrcSet, thumbUrl } from "./thumbs";

describe("thumbs", () => {
  it("builds the thumb URL for files and private files", () => {
    expect(thumbUrl("/files/a b.jpg", 480)).toBe(
      "/api/method/upande_scp.serverscripts.common.thumbs.thumb?src=%2Ffiles%2Fa%20b.jpg&w=480",
    );
    expect(thumbUrl("/private/files/x.jpg", 960)).toContain("src=%2Fprivate%2Ffiles%2Fx.jpg&w=960");
  });
  it("leaves other sources alone", () => {
    for (const s of ["https://x.test/a.jpg", "data:image/png;base64,AA", "/assets/a.png", "", "/files/a.jpg?x=1"]) {
      expect(isThumbable(s)).toBe(false);
      expect(thumbUrl(s, 480)).toBe(s);
      expect(thumbSrcSet(s)).toBe("");
    }
  });
  it("srcset lists 480w and 960w by default", () => {
    const set = thumbSrcSet("/files/a.jpg");
    expect(set).toMatch(/w=480 480w, .*w=960 960w$/);
  });
});
