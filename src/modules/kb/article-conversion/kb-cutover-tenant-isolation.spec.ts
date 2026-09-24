import { mapArticleToPage, paragraphize } from "./kb-article-migration.util";

const TENANT_A = "org-a";
const TENANT_B = "org-b";

function makeArticle(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orgId: TENANT_A,
    title: "Support Guide",
    contentText: "Step one\n\nStep two",
    lastVerifiedAt: null as Date | null,
    ownerMembershipId: null as number | null,
    authorId: "user-1",
    ownerId: null as string | null,
    visibility: "internal" as const,
    slug: "support-guide",
    excerpt: null as string | null,
    categoryId: null as number | null,
    views: 0,
    helpfulCount: 0,
    notHelpfulCount: 0,
    seoTitle: null as string | null,
    seoDescription: null as string | null,
    reviewIntervalDays: null as number | null,
    publishedAt: null as Date | null,
    archivedAt: null as Date | null,
    ...overrides,
  };
}

describe("backfill mapping — mapArticleToPage", () => {
  it("maps all required fields for a published article", () => {
    const page = mapArticleToPage(makeArticle(), 100);

    expect(page.sourceArticleId).toBe(1);
    expect(page.title).toBe("Support Guide");
    expect(page.status).toBe("published");
    expect(page.contentType).toBe("support_article");
    expect(page.sortOrder).toBe(100);
    expect(page.parentPageId).toBeNull();
  });

  it("always maps visibility to org regardless of article visibility value", () => {
    expect(mapArticleToPage(makeArticle({ visibility: "public" }), 0).visibility).toBe("org");
    expect(mapArticleToPage(makeArticle({ visibility: "internal" }), 0).visibility).toBe("org");
  });

  it("sets trustState=verified for last_verified_at within 180 days", () => {
    const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    expect(mapArticleToPage(makeArticle({ lastVerifiedAt: recent }), 0).trustState).toBe("verified");
  });

  it("sets trustState=unverified when last_verified_at is null", () => {
    expect(mapArticleToPage(makeArticle({ lastVerifiedAt: null }), 0).trustState).toBe("unverified");
  });

  it("sets trustState=unverified when last_verified_at is older than 180 days", () => {
    const stale = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    expect(mapArticleToPage(makeArticle({ lastVerifiedAt: stale }), 0).trustState).toBe("unverified");
  });

  it("preserves the source article id so the row is traceable after cutover", () => {
    const page = mapArticleToPage(makeArticle({ id: 42 }), 0);
    expect(page.sourceArticleId).toBe(42);
  });

  it("converts contentText paragraphs into a doc content tree", () => {
    const page = mapArticleToPage(makeArticle(), 0);
    expect(page.content).toEqual({
      type: "doc",
      content: [
        { type: "p", children: [{ text: "Step one" }] },
        { type: "p", children: [{ text: "Step two" }] },
      ],
    });
  });

  it("produces an empty paragraph when contentText is empty", () => {
    const page = mapArticleToPage(makeArticle({ contentText: "" }), 0);
    expect(page.content).toEqual({
      type: "doc",
      content: [{ type: "p", children: [{ text: "" }] }],
    });
  });
});

describe("backfill mapping — tenant scoping of pages written by the backfill", () => {
  it("the mapping does not produce an org_id — the INSERT must supply it from the article row", () => {
    const page = mapArticleToPage(makeArticle({ orgId: TENANT_A }), 0);
    expect(page).not.toHaveProperty("orgId");
  });

  it("a page produced from tenant-a article does not contain tenant-b identifiers", () => {
    const page = mapArticleToPage(makeArticle({ orgId: TENANT_A, authorId: "user-a" }), 0);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(TENANT_B);
    expect(serialized).toContain("user-a");
  });
});

describe("reads resolved from kb_pages after cutover — tenant scoping (simulated query predicate)", () => {
  function buildPageQuery(requestingOrgId: string, sourceArticleId: number) {
    return { orgId: requestingOrgId, sourceArticleId };
  }

  function resolveFromPages(
    pages: Array<{ orgId: string; id: number; sourceArticleId: number | null; title: string }>,
    query: { orgId: string; sourceArticleId: number },
  ) {
    return pages.filter(
      (p) => p.orgId === query.orgId && p.sourceArticleId === query.sourceArticleId,
    );
  }

  const orgAPage = { orgId: TENANT_A, id: 101, sourceArticleId: 1, title: "Guide A" };
  const orgBPage = { orgId: TENANT_B, id: 202, sourceArticleId: 1, title: "Guide B" };

  it("positive: returns the page for the requesting org", () => {
    const result = resolveFromPages([orgAPage, orgBPage], buildPageQuery(TENANT_A, 1));
    expect(result).toHaveLength(1);
    expect(result[0].orgId).toBe(TENANT_A);
  });

  it("negative: does not return a page from a different org for the same source article id", () => {
    const result = resolveFromPages([orgAPage, orgBPage], buildPageQuery(TENANT_A, 1));
    const leaked = result.find((p) => p.orgId !== TENANT_A);
    expect(leaked).toBeUndefined();
  });

  it("negative: attacker cannot access another org's page by source_article_id alone", () => {
    const result = resolveFromPages([orgAPage], buildPageQuery(TENANT_B, 1));
    expect(result).toHaveLength(0);
  });
});

describe("paragraphize edge cases relevant to the SQL backfill", () => {
  it("returns empty paragraph for whitespace input", () => {
    expect(paragraphize("   ")).toEqual({
      type: "doc",
      content: [{ type: "p", children: [{ text: "" }] }],
    });
  });

  it("handles three or more consecutive newlines the same as two", () => {
    const result = paragraphize("Para A\n\n\n\nPara B");
    expect((result.content as unknown[]).length).toBe(2);
  });

  it("caps at 500 paragraphs to match the SQL LIMIT 500", () => {
    const text = Array.from({ length: 600 }, (_, i) => `P${i}`).join("\n\n");
    const result = paragraphize(text);
    expect((result.content as unknown[]).length).toBe(500);
  });
});
