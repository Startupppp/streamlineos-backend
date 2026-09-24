import { paragraphize } from "./kb-page-content";

describe("paragraphize", () => {
  it("returns a single empty paragraph for null input", () => {
    expect(paragraphize(null)).toEqual({
      type: "doc",
      content: [{ type: "p", children: [{ text: "" }] }],
    });
  });

  it("returns a single empty paragraph for empty string", () => {
    expect(paragraphize("")).toEqual({
      type: "doc",
      content: [{ type: "p", children: [{ text: "" }] }],
    });
  });

  it("returns a single empty paragraph for whitespace-only string", () => {
    expect(paragraphize("   ")).toEqual({
      type: "doc",
      content: [{ type: "p", children: [{ text: "" }] }],
    });
  });

  it("splits on double newlines", () => {
    expect(paragraphize("First\n\nSecond")).toEqual({
      type: "doc",
      content: [
        { type: "p", children: [{ text: "First" }] },
        { type: "p", children: [{ text: "Second" }] },
      ],
    });
  });

  it("trims whitespace from each paragraph", () => {
    expect(paragraphize("  Hello  \n\n  World  ")).toEqual({
      type: "doc",
      content: [
        { type: "p", children: [{ text: "Hello" }] },
        { type: "p", children: [{ text: "World" }] },
      ],
    });
  });

  it("handles three or more consecutive newlines the same as two", () => {
    expect(paragraphize("First\n\n\n\nSecond")).toEqual({
      type: "doc",
      content: [
        { type: "p", children: [{ text: "First" }] },
        { type: "p", children: [{ text: "Second" }] },
      ],
    });
  });

  it("caps output at 500 paragraphs", () => {
    const text = Array.from({ length: 600 }, (_, i) => `Para ${i}`).join("\n\n");
    const content = paragraphize(text)["content"];
    expect(Array.isArray(content) ? content.length : -1).toBe(500);
  });

  it("wraps single-line content in one paragraph", () => {
    expect(paragraphize("Single line")).toEqual({
      type: "doc",
      content: [{ type: "p", children: [{ text: "Single line" }] }],
    });
  });
});
