import { kbArticleSchema, kbListSchema } from "./dto/public-response.schemas";

const ARTICLE = {
  id: 1,
  title: "Getting started",
  slug: "getting-started",
  content: "Create your account.",
  excerpt: "Everything you need.",
  categoryId: 4,
  categoryName: "Guides",
  categorySlug: "guides",
  views: 120,
  helpfulCount: 9,
  notHelpfulCount: 1,
  tags: ["onboarding"],
  seoTitle: "Getting started",
  seoDescription: "Learn how to get started.",
  publishedAt: new Date("2026-03-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-15T00:00:00.000Z"),
};

const LIST = {
  categories: [
    {
      id: 4,
      name: "Guides",
      slug: "guides",
      description: "How-to material",
      icon: "book",
      sortOrder: 2,
    },
  ],
  articles: [
    {
      id: 1,
      categoryId: 4,
      title: "Getting started",
      slug: "getting-started",
      excerpt: "Everything you need.",
      views: 120,
      helpfulCount: 9,
      notHelpfulCount: 1,
      tags: ["onboarding"],
      publishedAt: new Date("2026-03-01T00:00:00.000Z"),
    },
  ],
  pagination: { limit: 20, hasMore: false, nextCursor: null },
};

describe("the public help-centre response keeps the columns its service selects", () => {
  it("sends the article fields the public page renders, because the service selects them and a response schema that omits one strips it on the way out", () => {
    const parsed = kbArticleSchema.parse(ARTICLE);

    expect(parsed).toMatchObject({
      categoryId: 4,
      categorySlug: "guides",
      helpfulCount: 9,
      notHelpfulCount: 1,
      views: 120,
      tags: ["onboarding"],
    });
  });

  it("sends the list article fields the cards render", () => {
    const parsed = kbListSchema.parse(LIST);

    expect(parsed.articles[0]).toMatchObject({
      categoryId: 4,
      views: 120,
      helpfulCount: 9,
      notHelpfulCount: 1,
      tags: ["onboarding"],
    });
  });

  it("sends the category fields the sidebar orders and labels itself with", () => {
    const parsed = kbListSchema.parse(LIST);

    expect(parsed.categories[0]).toMatchObject({
      description: "How-to material",
      icon: "book",
      sortOrder: 2,
    });
  });

  it("keeps a never-viewed article parsable, because views, helpfulCount and notHelpfulCount carry a default but no NOT NULL", () => {
    const parsed = kbArticleSchema.parse({
      ...ARTICLE,
      views: null,
      helpfulCount: null,
      notHelpfulCount: null,
    });

    expect(parsed.views).toBeNull();
    expect(parsed.helpfulCount).toBeNull();
    expect(parsed.notHelpfulCount).toBeNull();
  });

  it("keeps an uncategorised article parsable, because categoryId is nullable and the category join is a left join", () => {
    const parsed = kbArticleSchema.parse({
      ...ARTICLE,
      categoryId: null,
      categoryName: null,
      categorySlug: null,
    });

    expect(parsed.categoryId).toBeNull();
    expect(parsed.categorySlug).toBeNull();
  });
});
