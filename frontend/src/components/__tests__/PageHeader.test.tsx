import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageHeader } from "@/components/PageHeader";

describe("PageHeader", () => {
  it("uses the Scouting Dashboard standard title, eyebrow and spacing", () => {
    render(
      <PageHeader title="Traps" eyebrow="Per-trap catches" switcher={<span>tabs</span>}>
        <span>filters</span>
      </PageHeader>,
    );
    const h1 = screen.getByRole("heading", { level: 1, name: "Traps" });
    expect(h1.className).toContain("text-[32px]");
    expect(h1.className).toContain("md:text-[44px]");
    expect(h1.className).toContain("font-semibold");
    expect(h1.className).toContain("leading-[1.05]");
    const eyebrow = screen.getByText("Per-trap catches").parentElement!;
    expect(eyebrow.className).toContain("text-[11px]");
    expect(eyebrow.className).toContain("tracking-[0.2em]");
    const header = screen.getByRole("banner");
    expect(header.className).toContain("gap-6");
    expect(header.className).toContain("md:gap-9");
    expect(header).toContainElement(screen.getByTestId("page-toolbar"));
  });
});
