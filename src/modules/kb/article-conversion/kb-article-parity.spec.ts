import { findParityMismatches } from "./kb-article-parity";

const PUBLISHED_AT = new Date("2024-03-15T10:00:00.000Z");

const baseArticle = {
  slug: "help-article-slug",
  title: "My Article",
  excerpt: "A brief excerpt",
  views: 42,
  helpfulCount: 10,
  notHelpfulCount: 2,
  seoTitle: "SEO Title",
  seoDescription: "SEO description text",
  reviewIntervalDays: 90,
  publishedAt: PUBLISHED_AT,
  archivedAt: null,
};

const matchingPage = {
  slug: "help-article-slug",
  title: "My Article",
  excerpt: "A brief excerpt",
  views: 42,
  helpfulCount: 10,
  notHelpfulCount: 2,
  seoTitle: "SEO Title",
  seoDescription: "SEO description text",
  reviewIntervalDays: 90,
  publishedAt: PUBLISHED_AT,
  archivedAt: null,
};

describe("findParityMismatches", () => {
  it("returns an empty array for a fully matching pair — proves the detector is not vacuously happy", () => {
    expect(findParityMismatches(baseArticle, matchingPage)).toEqual([]);
  });

  it("names the divergent column and both values when slug differs", () => {
    const mismatches = findParityMismatches(baseArticle, { ...matchingPage, slug: "other-slug" });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].column).toBe("slug");
    expect(mismatches[0].articleValue).toBe("help-article-slug");
    expect(mismatches[0].pageValue).toBe("other-slug");
  });

  it("names the divergent column and both values when views differs", () => {
    const mismatches = findParityMismatches(baseArticle, { ...matchingPage, views: 0 });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].column).toBe("views");
    expect(mismatches[0].articleValue).toBe(42);
    expect(mismatches[0].pageValue).toBe(0);
  });

  it("reports all divergent columns when multiple fields differ", () => {
    const mismatches = findParityMismatches(
      baseArticle,
      { ...matchingPage, slug: "x", views: 0, notHelpfulCount: 5 },
    );
    const columns = mismatches.map((m) => m.column);
    expect(columns).toContain("slug");
    expect(columns).toContain("views");
    expect(columns).toContain("notHelpfulCount");
  });

  it("detects a mismatch when article has published_at but page has null", () => {
    const mismatches = findParityMismatches(baseArticle, { ...matchingPage, publishedAt: null });
    expect(mismatches.map((m) => m.column)).toContain("publishedAt");
  });

  it("treats two different non-null timestamps as a mismatch", () => {
    const a = new Date("2024-01-01T00:00:00.000Z");
    const b = new Date("2024-06-01T00:00:00.000Z");
    const mismatches = findParityMismatches(
      { ...baseArticle, publishedAt: a },
      { ...matchingPage, publishedAt: b },
    );
    expect(mismatches.map((m) => m.column)).toContain("publishedAt");
  });

  it("does not report a mismatch when both timestamps are null", () => {
    const mismatches = findParityMismatches(
      { ...baseArticle, publishedAt: null },
      { ...matchingPage, publishedAt: null },
    );
    expect(mismatches.map((m) => m.column)).not.toContain("publishedAt");
  });

  it("reports nothing when every nullable column is null on both sides, so an all-null article is not read as total data loss", () => {
    const nulls = {
      slug: null,
      excerpt: null,
      seoTitle: null,
      seoDescription: null,
      reviewIntervalDays: null,
      publishedAt: null,
    };
    expect(
      findParityMismatches({ ...baseArticle, ...nulls }, { ...matchingPage, ...nulls }),
    ).toEqual([]);
  });
});
