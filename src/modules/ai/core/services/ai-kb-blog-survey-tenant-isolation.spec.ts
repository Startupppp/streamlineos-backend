jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) => fn(_db),
  runInNewTenantTransaction: (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
}));

jest.mock("../../../integrations/core/composio.gateway", () => ({
  ComposioGateway: class {},
  ComposioToolError: class extends Error {},
}));

import { NotFoundException } from "@nestjs/common";
import { KbRagService } from "./kb-rag.service";
import { SurveyAiService } from "./survey-ai.service";
import { OrgFeaturesService } from "./org-features.service";
import { MeetingsPrepService } from "./meetings-prep.service";
import type { Db } from "../../../../db/drizzle.module";

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

beforeEach(() => jest.resetAllMocks());

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

interface FluentChain extends PromiseLike<unknown[]> {
  from: jest.Mock;
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
}

function makeFluentChain(finalResult: unknown[]): FluentChain {
  const chain = {} as FluentChain;
  chain.from = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue(finalResult);
  chain.then = function<TResult1 = unknown[], TResult2 = never>(
    onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(finalResult).then(onfulfilled, onrejected);
  };
  return chain;
}

// ---------------------------------------------------------------------------
// KbRagService
// ---------------------------------------------------------------------------

describe("KbRagService tenant isolation", () => {
  it("DENY: short-circuits when org has no published articles — embedQueryWithCredit never called", async () => {
    const noArticlesChain = makeFluentChain([]);
    const mockDb = {
      select: jest.fn().mockReturnValue(noArticlesChain),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
    };
    const mockGateway = {
      invokeText: jest.fn(),
      embedQueryWithCredit: jest.fn(),
      isEmbeddingConfigured: jest.fn().mockReturnValue(true),
    };
    const mockLedger = { reserve: jest.fn(), settle: jest.fn(), release: jest.fn() };
    const mockUsageSvc = { track: jest.fn() };

    const svc = new KbRagService(
      mockDb as unknown as Db,
      mockGateway as unknown as ConstructorParameters<typeof KbRagService>[1],
      mockLedger as unknown as ConstructorParameters<typeof KbRagService>[2],
      mockUsageSvc as unknown as ConstructorParameters<typeof KbRagService>[3],
    );

    const result = await svc.answerQuestion({ orgId: OWNER_ORG, question: "What is X?" });

    expect(result.hasContext).toBe(false);
    expect(result.answer).toMatch(/couldn't find/i);
    expect(mockGateway.embedQueryWithCredit).not.toHaveBeenCalled();
  });

  it("CONTROL: chunk query is scoped to owner org and answer is returned", async () => {
    const articleRow = { id: 1 };
    const chunkRows = [
      {
        id: 1,
        articleId: 1,
        attachmentId: null,
        source: "body",
        content: "Knowledge base content here",
        title: "Test Article",
        slug: "test-article",
        attachmentName: null,
        similarity: 0.9,
      },
    ];

    const hasArticlesChain = makeFluentChain([articleRow]);
    const fetchChunksChain = makeFluentChain(chunkRows);

    let selectCallCount = 0;
    const mockDb = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        return selectCallCount === 1 ? hasArticlesChain : fetchChunksChain;
      }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
    };
    const mockGateway = {
      invokeText: jest.fn().mockResolvedValue({ ok: true, data: "answer text" }),
      embedQueryWithCredit: jest.fn().mockResolvedValue({ ok: true, vector: [0.1, 0.2, 0.3], vectorLiteral: "[0.1,0.2,0.3]" }),
      isEmbeddingConfigured: jest.fn().mockReturnValue(true),
    };
    const mockLedger = { reserve: jest.fn(), settle: jest.fn(), release: jest.fn() };
    const mockUsageSvc = { track: jest.fn() };

    const svc = new KbRagService(
      mockDb as unknown as Db,
      mockGateway as unknown as ConstructorParameters<typeof KbRagService>[1],
      mockLedger as unknown as ConstructorParameters<typeof KbRagService>[2],
      mockUsageSvc as unknown as ConstructorParameters<typeof KbRagService>[3],
    );

    const result = await svc.answerQuestion({ orgId: OWNER_ORG, question: "What is X?" });

    expect(result.hasContext).toBe(true);
    expect(mockGateway.embedQueryWithCredit).toHaveBeenCalledWith(
      expect.objectContaining({ text: "What is X?", orgId: OWNER_ORG, charge: true }),
    );

    // The chunk query's where predicate must scope to OWNER_ORG.
    const whereArg = fetchChunksChain.where.mock.calls[0]?.[0];
    expect(sqlValues(whereArg)).toContain(OWNER_ORG);
    expect(sqlValues(whereArg)).not.toContain(ATTACKER_ORG);
  });
});

// ---------------------------------------------------------------------------
// SurveyAiService
// ---------------------------------------------------------------------------

describe("SurveyAiService tenant isolation", () => {
  it("DENY: throws NotFoundException when survey id is not in the caller's org", async () => {
    const noSurveyChain = makeFluentChain([]);
    const mockDb = {
      select: jest.fn().mockReturnValue(noSurveyChain),
    };
    const mockGateway = {
      invokeText: jest.fn().mockResolvedValue({ ok: true, data: "Survey summary text" }),
    };
    const mockAudit = { log: jest.fn() };

    const svc = new SurveyAiService(
      mockDb as unknown as Db,
      mockGateway as unknown as ConstructorParameters<typeof SurveyAiService>[1],
      mockAudit as unknown as ConstructorParameters<typeof SurveyAiService>[2],
    );

    await expect(svc.summarizeResponses(OWNER_ORG, "user-1", 42)).rejects.toThrow(NotFoundException);
    expect(mockGateway.invokeText).not.toHaveBeenCalled();
  });

  it("CONTROL: summarizes responses for the correct org and returns summary", async () => {
    const surveyRow = { id: 42, title: "Q1 Survey" };
    const countRow = { total: 2 };
    const answerRow = { questionTitle: "How satisfied?", answerText: "Very satisfied" };

    const chain1 = makeFluentChain([surveyRow]);
    const chain2 = makeFluentChain([countRow]);
    const chain3 = makeFluentChain([answerRow]);

    let selectCallCount = 0;
    const mockDb = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return chain1;
        if (selectCallCount === 2) return chain2;
        return chain3;
      }),
    };
    const mockGateway = {
      invokeText: jest.fn().mockResolvedValue({ ok: true, data: "Survey summary text" }),
    };
    const mockAudit = { log: jest.fn() };

    const svc = new SurveyAiService(
      mockDb as unknown as Db,
      mockGateway as unknown as ConstructorParameters<typeof SurveyAiService>[1],
      mockAudit as unknown as ConstructorParameters<typeof SurveyAiService>[2],
    );

    const result = await svc.summarizeResponses(OWNER_ORG, "user-1", 42);

    expect(result.summary).toBe("Survey summary text");
    expect(mockGateway.invokeText).toHaveBeenCalledTimes(1);
    expect(mockAudit.log).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: OWNER_ORG, resourceId: "42" }),
    );

    // Survey lookup must be scoped to OWNER_ORG.
    const surveyWhereArg = chain1.where.mock.calls[0]?.[0];
    expect(sqlValues(surveyWhereArg)).toContain(OWNER_ORG);
  });
});

// ---------------------------------------------------------------------------
// OrgFeaturesService
// ---------------------------------------------------------------------------

describe("OrgFeaturesService tenant isolation", () => {
  it("DENY: database query uses attacker org id — no bleed from owner org", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const mockDb = { query: { organizations: { findFirst } } };

    const svc = new OrgFeaturesService(mockDb as unknown as Db);

    const flags = await svc.getFlags(ATTACKER_ORG);

    // Null → all defaults (feature flags not leaked from another org).
    expect(flags.aiChat).toBe(true);

    const queryOpts = findFirst.mock.calls[0]?.[0] as { where: unknown } | undefined;
    expect(queryOpts).toBeDefined();
    expect(sqlValues(queryOpts?.where)).toContain(ATTACKER_ORG);
    expect(sqlValues(queryOpts?.where)).not.toContain(OWNER_ORG);
  });

  it("CONTROL: returns org-specific feature flag overrides", async () => {
    const findFirst = jest.fn().mockResolvedValue({
      settings: { features: { aiChat: false } },
    });
    const mockDb = { query: { organizations: { findFirst } } };

    const svc = new OrgFeaturesService(mockDb as unknown as Db);

    const flags = await svc.getFlags(OWNER_ORG);

    expect(flags.aiChat).toBe(false);

    const queryOpts = findFirst.mock.calls[0]?.[0] as { where: unknown } | undefined;
    expect(sqlValues(queryOpts?.where)).toContain(OWNER_ORG);
  });
});

// ---------------------------------------------------------------------------
// MeetingsPrepService
// ---------------------------------------------------------------------------

describe("MeetingsPrepService tenant isolation", () => {
  it("DENY: throws NotFoundException when event id does not belong to the caller's org", async () => {
    const noEventChain = makeFluentChain([]);
    const mockDb = {
      select: jest.fn().mockReturnValue(noEventChain),
    };
    const mockGateway = {
      invokeStructured: jest.fn(),
    };
    const mockComposio = { isConfigured: jest.fn().mockReturnValue(false) };

    const svc = new MeetingsPrepService(
      mockDb as unknown as Db,
      mockGateway as unknown as ConstructorParameters<typeof MeetingsPrepService>[1],
      {} as unknown as ConstructorParameters<typeof MeetingsPrepService>[2],
      mockComposio as unknown as ConstructorParameters<typeof MeetingsPrepService>[3],
    );

    await expect(svc.draftAgenda(OWNER_ORG, "user-1", "1", {})).rejects.toThrow(NotFoundException);
    expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
  });

  it("CONTROL: agenda drafted for event scoped to owner org, orgId in where predicate", async () => {
    const eventRow = {
      id: 1,
      title: "Team Sync",
      startDate: new Date("2026-09-01T10:00:00Z"),
      endDate: new Date("2026-09-01T11:00:00Z"),
      description: null,
      location: null,
      meetingUrl: null,
      agenda: null,
      entityType: null,
      entityId: null,
      linkedLeadId: null,
      linkedDealId: null,
      createdBy: "user-1",
      externalEventId: null,
      integrationConnectionId: null,
    };

    const eventChain = makeFluentChain([eventRow]);
    const attendeesChain = makeFluentChain([]);

    let selectCallCount = 0;
    const mockDb = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        return selectCallCount === 1 ? eventChain : attendeesChain;
      }),
    };
    const mockGateway = {
      invokeStructured: jest.fn().mockResolvedValue({
        ok: true,
        data: {
          agenda: "1. Discuss Q3 goals",
          keyTopics: ["Goals", "Blockers"],
          citations: [],
        },
      }),
    };
    const mockComposio = { isConfigured: jest.fn().mockReturnValue(false) };

    const svc = new MeetingsPrepService(
      mockDb as unknown as Db,
      mockGateway as unknown as ConstructorParameters<typeof MeetingsPrepService>[1],
      {} as unknown as ConstructorParameters<typeof MeetingsPrepService>[2],
      mockComposio as unknown as ConstructorParameters<typeof MeetingsPrepService>[3],
    );

    const result = await svc.draftAgenda(OWNER_ORG, "user-1", "1", {});

    expect(result.agenda.agenda).toBe("1. Discuss Q3 goals");
    expect(mockGateway.invokeStructured).toHaveBeenCalledTimes(1);

    // calendarEvents where clause must include OWNER_ORG.
    const eventWhereArg = eventChain.where.mock.calls[0]?.[0];
    expect(sqlValues(eventWhereArg)).toContain(OWNER_ORG);
    expect(sqlValues(eventWhereArg)).not.toContain(ATTACKER_ORG);
  });
});
