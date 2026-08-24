import { toMarkdown, toHtml } from "./kb-export-serializer";

describe("kb-export-serializer", () => {
  describe("toMarkdown", () => {
    it("returns h1 heading and content", () => {
      expect(toMarkdown("My Page", "Some content")).toBe("# My Page\n\nSome content");
    });

    it("handles null contentText", () => {
      expect(toMarkdown("My Page", null)).toBe("# My Page\n\n");
    });
  });

  describe("toHtml", () => {
    it("wraps title in h1 and each non-empty line in p", () => {
      expect(toHtml("My Page", "Line one\nLine two")).toBe(
        "<h1>My Page</h1>\n<p>Line one</p>\n<p>Line two</p>",
      );
    });

    it("escapes HTML entities in title", () => {
      expect(toHtml("<Test>", null)).toBe("<h1>&lt;Test&gt;</h1>\n");
    });

    it("escapes HTML entities in content lines", () => {
      expect(toHtml("Title", "<script>alert(1)</script>")).toBe(
        "<h1>Title</h1>\n<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
      );
    });

    it("escapes ampersands", () => {
      expect(toHtml("A & B", "x & y")).toBe(
        "<h1>A &amp; B</h1>\n<p>x &amp; y</p>",
      );
    });

    it("handles null contentText", () => {
      expect(toHtml("My Page", null)).toBe("<h1>My Page</h1>\n");
    });

    it("skips blank lines", () => {
      expect(toHtml("T", "A\n\nB")).toBe("<h1>T</h1>\n<p>A</p>\n<p>B</p>");
    });
  });
});
