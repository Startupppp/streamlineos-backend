import { buildBlogRss, escapeXml } from "./blog-rss";
import type { BlogCard } from "../blog-public.projection";

const card = (over: Partial<BlogCard>): BlogCard => ({
  id: "00000000-0000-4000-8000-000000000001",
  title: "Title",
  slug: "a-post",
  excerpt: "Excerpt",
  coverImage: "",
  cover: null,
  isFeatured: false,
  readingTime: 3,
  tags: [],
  publishedAt: new Date("2026-09-01T10:00:00Z"),
  modifiedAt: new Date("2026-09-02T10:00:00Z"),
  category: { name: "People operations", slug: "people-operations", color: null },
  author: { name: "Ada", slug: "ada", avatar: null, role: null },
  ...over,
});

describe("blog RSS", () => {
  it("escapes markup in titles so an item cannot inject elements", () => {
    const xml = buildBlogRss({ siteOrigin: "https://www.example.test", title: "J", description: "D" }, [
      card({ title: "</title><script>alert(1)</script> & more" }),
    ]);
    expect(xml).not.toContain("<script>");
    expect(xml).toContain("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
  });

  it("links every item to its canonical URL with a stable guid", () => {
    const xml = buildBlogRss({ siteOrigin: "https://www.example.test", title: "J", description: "D" }, [card({})]);
    expect(xml).toContain("<link>https://www.example.test/blogs/a-post</link>");
    expect(xml).toContain('<guid isPermaLink="false">urn:uuid:00000000-0000-4000-8000-000000000001</guid>');
    expect(xml).toContain("<pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate>");
  });

  it("drops characters XML cannot carry and keeps ordinary Unicode", () => {
    expect(escapeXml("a\u0000b\u0008c — ünïcødé")).toBe("abc — ünïcødé");
  });
});
