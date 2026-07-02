import { TEMPLATE_MAP } from "./test-catalog";

describe("Email template catalog smoke-check", () => {
  const entries = Object.entries(TEMPLATE_MAP);

  it("catalog exposes at least one entry", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)("%s — renders without throw and passes content assertions", (key, entry) => {
    let html = "";

    expect(() => {
      html = entry.generateHtml();
    }).not.toThrow();

    expect(html).toContain("<!DOCTYPE html");
    expect(html).toContain("StreamlineOS");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("[object Object]");
    expect(html).not.toMatch(/0f2b7f/i);
    expect(html).not.toMatch(/bd882c/i);
    expect(html).not.toContain("${");
  });
});
