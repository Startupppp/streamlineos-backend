import { restrictToCited, type AskCitation } from "./kb-ask.service";

type Top = { kind: "article" | "page"; id: number; title: string };
type Source = { sourceId: number; title: string };

function articleCitation(articleId: number): AskCitation {
  return {
    kind: "article",
    articleId,
    title: `article ${articleId}`,
    slug: `a-${articleId}`,
    spaceId: 1,
    updatedAt: new Date("2024-01-01"),
  };
}

function sourceCitation(sourceId: number): AskCitation {
  return {
    kind: "source",
    sourceId,
    title: `source ${sourceId}`,
    spaceId: 1,
    updatedAt: new Date("2024-01-01"),
  };
}

describe("restrictToCited — the prompt context is built from verified citations", () => {
  const retrieved: Top[] = [
    { kind: "article", id: 1, title: "visible" },
    { kind: "article", id: 2, title: "RESTRICTED" },
    { kind: "page", id: 7, title: "visible page" },
    { kind: "page", id: 8, title: "RESTRICTED page" },
  ];
  const retrievedSources: Source[] = [
    { sourceId: 100, title: "visible doc" },
    { sourceId: 200, title: "RESTRICTED doc" },
  ];

  it("drops every retrieved item that did not survive citation verification", () => {
    const { top, sources } = restrictToCited(retrieved, retrievedSources, [
      articleCitation(1),
      { kind: "page", pageId: 7, title: "visible page", spaceId: 1, updatedAt: new Date() },
      sourceCitation(100),
    ]);

    expect(top.map((t) => t.id)).toEqual([1, 7]);
    expect(sources.map((s) => s.sourceId)).toEqual([100]);
  });

  it("BITE: a restricted article never reaches the text handed to the model", () => {
    const { top } = restrictToCited(retrieved, retrievedSources, [articleCitation(1)]);
    const contextText = top.map((t) => t.title).join("\n");

    expect(contextText).not.toContain("RESTRICTED");
  });

  it("an article id and a page id that collide are not confused for one another", () => {
    const colliding: Top[] = [
      { kind: "article", id: 42, title: "article forty-two" },
      { kind: "page", id: 42, title: "page forty-two" },
    ];

    const { top } = restrictToCited(colliding, [], [articleCitation(42)]);

    expect(top).toEqual([{ kind: "article", id: 42, title: "article forty-two" }]);
  });

  it("verifying nothing yields no context at all", () => {
    const { top, sources } = restrictToCited(retrieved, retrievedSources, []);

    expect(top).toEqual([]);
    expect(sources).toEqual([]);
  });
});
