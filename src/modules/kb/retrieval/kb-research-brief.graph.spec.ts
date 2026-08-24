import { buildResearchBriefGraph, runResearchBrief } from "./kb-research-brief.graph";
import type { RetrievedSource } from "./kb-search.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const makeTextOk = (text: string) => ({
  ok: true as const,
  data: text,
  model: "gpt-4o-mini",
  latencyMs: 10,
  correlationId: "c1",
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
});

const makeStructuredOk = <T>(data: T) => ({
  ok: true as const,
  data,
  model: "gpt-4o-mini",
  latencyMs: 10,
  correlationId: "c2",
  usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
});

const makeFail = (message = "quota exceeded") => ({
  ok: false as const,
  kind: "quota_exceeded" as const,
  message,
  correlationId: "cerr",
});

const articleA: RetrievedSource = {
  kind: "article",
  id: 1,
  title: "Article One",
  slug: "article-one",
  spaceId: 1,
  contentText: "Article one content",
  updatedAt: new Date("2024-01-01"),
};

const articleB: RetrievedSource = {
  kind: "page",
  id: 2,
  title: "Page Two",
  spaceId: 1,
  contentText: "Page two content",
  updatedAt: new Date("2024-02-01"),
};

const sourceA = {
  sourceId: 10,
  title: "Source Doc",
  spaceId: null,
  snippet: "Source snippet text",
  updatedAt: new Date("2024-03-01"),
};

const userCtx: CurrentUserContext = {
  orgId: "org1",
  userId: "user1",
  role: "member",
  permissions: [],
  isOrgOwner: false,
  sessionId: "",
  tokenScopes: null,
};

const actor = { orgId: "org1", userId: "user1" };

function makeGateway(overrides: Partial<{ invokeText: jest.Mock; invokeStructured: jest.Mock }> = {}) {
  return {
    invokeText: overrides.invokeText ?? jest.fn(),
    invokeStructured: overrides.invokeStructured ?? jest.fn(),
  };
}

function makeSearch(overrides: Partial<{ retrieveTopArticles: jest.Mock; retrieveTopSources: jest.Mock }> = {}) {
  return {
    retrieveTopArticles: overrides.retrieveTopArticles ?? jest.fn().mockResolvedValue([articleA]),
    retrieveTopSources: overrides.retrieveTopSources ?? jest.fn().mockResolvedValue([sourceA]),
  };
}

describe("buildResearchBriefGraph", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("plan node", () => {
    it("produces sub-questions from gateway invokeStructured", async () => {
      const gateway = makeGateway({
        invokeStructured: jest.fn()
          .mockResolvedValueOnce(makeStructuredOk({ subQuestions: ["Q1", "Q2", "Q3"] }))
          .mockResolvedValueOnce(makeStructuredOk({ grounded: true, gaps: [] })),
        invokeText: jest.fn().mockResolvedValue(makeTextOk("## Report")),
      });
      const search = makeSearch();

      const graph = buildResearchBriefGraph({ gateway: gateway as never, search: search as never });
      const result = await runResearchBrief(graph, { topic: "test topic", userCtx, actor });

      const firstCall = gateway.invokeStructured.mock.calls[0][0];
      expect(firstCall.prompt.user).toContain("test topic");
      expect(firstCall.tier).toBe("fast");
      expect(result.report).toBe("## Report");
    });
  });

  describe("retrieve node", () => {
    it("gathers articles and sources using userCtx for permission-safe retrieval", async () => {
      const retrieveTopArticles = jest.fn().mockResolvedValue([articleA]);
      const retrieveTopSources = jest.fn().mockResolvedValue([sourceA]);

      const gateway = makeGateway({
        invokeStructured: jest.fn()
          .mockResolvedValueOnce(makeStructuredOk({ subQuestions: ["Q1"] }))
          .mockResolvedValueOnce(makeStructuredOk({ grounded: true, gaps: [] })),
        invokeText: jest.fn().mockResolvedValue(makeTextOk("Report")),
      });

      const graph = buildResearchBriefGraph({
        gateway: gateway as never,
        search: { retrieveTopArticles, retrieveTopSources } as never,
      });
      await runResearchBrief(graph, { topic: "access control", userCtx, actor });

      expect(retrieveTopArticles).toHaveBeenCalledWith(userCtx, expect.any(String), expect.any(Number), undefined);
      expect(retrieveTopSources).toHaveBeenCalledWith(userCtx, expect.any(String), expect.any(Number));
    });

    it("deduplicates articles with identical kind+id across sub-question queries", async () => {
      const retrieveTopArticles = jest.fn().mockResolvedValue([articleA, articleA]);
      const retrieveTopSources = jest.fn().mockResolvedValue([]);

      const gateway = makeGateway({
        invokeStructured: jest.fn()
          .mockResolvedValueOnce(makeStructuredOk({ subQuestions: ["Q1", "Q2"] }))
          .mockResolvedValueOnce(makeStructuredOk({ grounded: true, gaps: [] })),
        invokeText: jest.fn().mockResolvedValue(makeTextOk("Report")),
      });

      const graph = buildResearchBriefGraph({
        gateway: gateway as never,
        search: { retrieveTopArticles, retrieveTopSources } as never,
      });
      const result = await runResearchBrief(graph, { topic: "dedupe", userCtx, actor });

      const citedIds = result.citations.map((c) => c.id);
      const unique = new Set(citedIds.map((id) => id));
      expect(unique.size).toBe(citedIds.length);
    });

    it("passes spaceId to retrieveTopArticles when provided", async () => {
      const retrieveTopArticles = jest.fn().mockResolvedValue([articleA]);
      const retrieveTopSources = jest.fn().mockResolvedValue([]);

      const gateway = makeGateway({
        invokeStructured: jest.fn()
          .mockResolvedValueOnce(makeStructuredOk({ subQuestions: ["Q1"] }))
          .mockResolvedValueOnce(makeStructuredOk({ grounded: true, gaps: [] })),
        invokeText: jest.fn().mockResolvedValue(makeTextOk("Report")),
      });

      const graph = buildResearchBriefGraph({
        gateway: gateway as never,
        search: { retrieveTopArticles, retrieveTopSources } as never,
      });
      await runResearchBrief(graph, { topic: "scoped", spaceId: 42, userCtx, actor });

      expect(retrieveTopArticles).toHaveBeenCalledWith(userCtx, expect.any(String), expect.any(Number), 42);
    });
  });

  describe("critique + refine loop", () => {
    it("loops draft node when critique returns ungrounded (refineCount < 2)", async () => {
      const invokeText = jest.fn()
        .mockResolvedValueOnce(makeTextOk("Draft 1"))
        .mockResolvedValueOnce(makeTextOk("Draft 2 revised"));

      const invokeStructured = jest.fn()
        .mockResolvedValueOnce(makeStructuredOk({ subQuestions: ["Q1"] }))
        .mockResolvedValueOnce(makeStructuredOk({ grounded: false, gaps: ["missing X"] }))
        .mockResolvedValueOnce(makeStructuredOk({ grounded: true, gaps: [] }));

      const gateway = makeGateway({ invokeText, invokeStructured });
      const search = makeSearch();

      const graph = buildResearchBriefGraph({ gateway: gateway as never, search: search as never });
      const result = await runResearchBrief(graph, { topic: "loop test", userCtx, actor });

      expect(invokeText).toHaveBeenCalledTimes(2);
      expect(result.report).toBe("Draft 2 revised");
    });

    it("includes prior gap guidance in the draft prompt on refinement", async () => {
      const invokeText = jest.fn()
        .mockResolvedValueOnce(makeTextOk("Draft 1"))
        .mockResolvedValueOnce(makeTextOk("Draft 2"));

      const invokeStructured = jest.fn()
        .mockResolvedValueOnce(makeStructuredOk({ subQuestions: ["Q1"] }))
        .mockResolvedValueOnce(makeStructuredOk({ grounded: false, gaps: ["missing detail about X"] }))
        .mockResolvedValueOnce(makeStructuredOk({ grounded: true, gaps: [] }));

      const gateway = makeGateway({ invokeText, invokeStructured });
      const graph = buildResearchBriefGraph({ gateway: gateway as never, search: makeSearch() as never });
      await runResearchBrief(graph, { topic: "gaps", userCtx, actor });

      const secondDraftPrompt = invokeText.mock.calls[1][0].prompt.user;
      expect(secondDraftPrompt).toContain("missing detail about X");
    });

    it("caps refinement at 2 loops even when critique stays ungrounded", async () => {
      const invokeText = jest.fn().mockResolvedValue(makeTextOk("Draft"));

      const invokeStructured = jest.fn()
        .mockResolvedValueOnce(makeStructuredOk({ subQuestions: ["Q1"] }))
        .mockResolvedValueOnce(makeStructuredOk({ grounded: false, gaps: ["gap 1"] }))
        .mockResolvedValueOnce(makeStructuredOk({ grounded: false, gaps: ["gap 2"] }));

      const gateway = makeGateway({ invokeText, invokeStructured });
      const graph = buildResearchBriefGraph({ gateway: gateway as never, search: makeSearch() as never });
      const result = await runResearchBrief(graph, { topic: "cap test", userCtx, actor });

      expect(invokeText).toHaveBeenCalledTimes(2);
      expect(result.report).toBe("Draft");
    });

    it("goes straight to finalize when critique is grounded on first pass", async () => {
      const invokeText = jest.fn().mockResolvedValueOnce(makeTextOk("Single draft"));

      const invokeStructured = jest.fn()
        .mockResolvedValueOnce(makeStructuredOk({ subQuestions: ["Q1"] }))
        .mockResolvedValueOnce(makeStructuredOk({ grounded: true, gaps: [] }));

      const gateway = makeGateway({ invokeText, invokeStructured });
      const graph = buildResearchBriefGraph({ gateway: gateway as never, search: makeSearch() as never });
      const result = await runResearchBrief(graph, { topic: "grounded", userCtx, actor });

      expect(invokeText).toHaveBeenCalledTimes(1);
      expect(result.report).toBe("Single draft");
    });
  });

  describe("finalize node", () => {
    it("builds citations from retrieved articles and sources", async () => {
      const retrieveTopArticles = jest.fn()
        .mockResolvedValue([articleA, articleB]);
      const retrieveTopSources = jest.fn()
        .mockResolvedValue([sourceA]);

      const gateway = makeGateway({
        invokeStructured: jest.fn()
          .mockResolvedValueOnce(makeStructuredOk({ subQuestions: ["Q1"] }))
          .mockResolvedValueOnce(makeStructuredOk({ grounded: true, gaps: [] })),
        invokeText: jest.fn().mockResolvedValue(makeTextOk("Report")),
      });

      const graph = buildResearchBriefGraph({
        gateway: gateway as never,
        search: { retrieveTopArticles, retrieveTopSources } as never,
      });
      const result = await runResearchBrief(graph, { topic: "citations", userCtx, actor });

      const articleCitation = result.citations.find((c) => c.id === 1);
      expect(articleCitation?.href).toBe("/support/kb/1");
      expect(articleCitation?.kind).toBe("article");

      const pageCitation = result.citations.find((c) => c.id === 2);
      expect(pageCitation?.href).toBe("/support/kb/pages/2");
      expect(pageCitation?.kind).toBe("page");

      const sourceCitation = result.citations.find((c) => c.id === 10);
      expect(sourceCitation?.href).toBeNull();
      expect(sourceCitation?.kind).toBe("source");

      expect(result.citations.every((c) => typeof c.updatedAt === "string")).toBe(true);
    });
  });

  describe("gateway failure handling", () => {
    it("rejects the run when plan node gateway call fails", async () => {
      const gateway = makeGateway({
        invokeStructured: jest.fn().mockResolvedValueOnce(makeFail("quota exceeded")),
        invokeText: jest.fn(),
      });

      const graph = buildResearchBriefGraph({ gateway: gateway as never, search: makeSearch() as never });
      await expect(
        runResearchBrief(graph, { topic: "fail", userCtx, actor }),
      ).rejects.toThrow("quota exceeded");
    });

    it("rejects the run when draft node gateway call fails", async () => {
      const gateway = makeGateway({
        invokeStructured: jest.fn().mockResolvedValueOnce(makeStructuredOk({ subQuestions: ["Q1"] })),
        invokeText: jest.fn().mockResolvedValueOnce(makeFail("provider error")),
      });

      const graph = buildResearchBriefGraph({ gateway: gateway as never, search: makeSearch() as never });
      await expect(
        runResearchBrief(graph, { topic: "fail draft", userCtx, actor }),
      ).rejects.toThrow("provider error");
    });

    it("rejects the run when critique node gateway call fails", async () => {
      const invokeStructured = jest.fn()
        .mockResolvedValueOnce(makeStructuredOk({ subQuestions: ["Q1"] }))
        .mockResolvedValueOnce(makeFail("critique fail"));

      const gateway = makeGateway({
        invokeStructured,
        invokeText: jest.fn().mockResolvedValue(makeTextOk("Draft")),
      });

      const graph = buildResearchBriefGraph({ gateway: gateway as never, search: makeSearch() as never });
      await expect(
        runResearchBrief(graph, { topic: "fail critique", userCtx, actor }),
      ).rejects.toThrow("critique fail");
    });
  });
});
