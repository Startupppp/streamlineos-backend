import { paragraphize, mapArticleToPage } from "./kb-article-migration.util";

const baseArticle = {
  id: 1,
  orgId: "org-1",
  categoryId: null,
  spaceId: null,
  title: "Test Article",
  slug: "test-article",
  excerpt: null,
  content: "<p>content</p>",
  contentText: "First paragraph\n\nSecond paragraph",
  status: "published" as const,
  visibility: "public" as const,
  authorId: "user-author",
  ownerId: "user-owner",
  views: 0,
  helpfulCount: 0,
  notHelpfulCount: 0,
  tags: null,
  fts: null,
  seoTitle: null,
  seoDescription: null,
  reviewIntervalDays: null,
  lastVerifiedAt: null,
  publishedAt: null,
  archivedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

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

  it("caps output at 500 paragraphs", () => {
    const text = Array.from({ length: 600 }, (_, i) => `Para ${i}`).join("\n\n");
    const result = paragraphize(text);
    expect((result.content as unknown[]).length).toBe(500);
  });

  it("wraps single-line content in one paragraph", () => {
    const result = paragraphize("Single line");
    expect(result).toEqual({
      type: "doc",
      content: [{ type: "p", children: [{ text: "Single line" }] }],
    });
  });
});

describe("mapArticleToPage", () => {
  it("maps core fields correctly", () => {
    const result = mapArticleToPage(baseArticle, 100);
    expect(result.title).toBe("Test Article");
    expect(result.status).toBe("published");
    expect(result.contentType).toBe("support_article");
    expect(result.visibility).toBe("org");
    expect(result.sourceArticleId).toBe(1);
    expect(result.sortOrder).toBe(100);
    expect(result.parentPageId).toBeNull();
  });

  it("converts article visibility=public to page visibility=org", () => {
    const result = mapArticleToPage({ ...baseArticle, visibility: "public" }, 100);
    expect(result.visibility).toBe("org");
  });

  it("converts article visibility=internal to page visibility=org", () => {
    const result = mapArticleToPage({ ...baseArticle, visibility: "internal" }, 100);
    expect(result.visibility).toBe("org");
  });

  it("sets trustState=verified when lastVerifiedAt within 180 days", () => {
    const recent = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    expect(mapArticleToPage({ ...baseArticle, lastVerifiedAt: recent }, 100).trustState).toBe("verified");
  });

  it("sets trustState=unverified when lastVerifiedAt is null", () => {
    expect(mapArticleToPage(baseArticle, 100).trustState).toBe("unverified");
  });

  it("sets trustState=unverified when lastVerifiedAt older than 180 days", () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    expect(mapArticleToPage({ ...baseArticle, lastVerifiedAt: old }, 100).trustState).toBe("unverified");
  });

  it("uses authorId for createdById", () => {
    expect(mapArticleToPage(baseArticle, 100).createdById).toBe("user-author");
  });

  it("falls back to ownerId when authorId is null", () => {
    expect(mapArticleToPage({ ...baseArticle, authorId: null }, 100).createdById).toBe("user-owner");
  });

  it("sets createdById to null when both authorId and ownerId are null", () => {
    expect(mapArticleToPage({ ...baseArticle, authorId: null, ownerId: null }, 100).createdById).toBeNull();
  });

  it("converts empty contentText to null", () => {
    expect(mapArticleToPage({ ...baseArticle, contentText: "" }, 100).contentText).toBeNull();
  });

  it("builds content doc from contentText paragraphs", () => {
    const result = mapArticleToPage(baseArticle, 100);
    expect(result.content).toEqual({
      type: "doc",
      content: [
        { type: "p", children: [{ text: "First paragraph" }] },
        { type: "p", children: [{ text: "Second paragraph" }] },
      ],
    });
  });
});
