import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { KbAskService } from "./kb-ask.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { NO_LINKED_DOCUMENTS } from "../../../test/kb-linked-document-ask-source.spec-fixtures";
import type { Db } from "../../../db/drizzle.module";

const user = {
  userId: "user-reconstruct",
  orgId: "org-reconstruct",
  role: "member",
  isOrgOwner: false,
  sessionId: "sess-r",
  tokenScopes: null,
  principal: humanSessionPrincipal(10, false),
};

interface InsertedRow {
  orgId?: string;
  correlationId?: string;
  resultState?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costCredits?: number;
  model?: string;
  gatewayCorrelationId?: string;
  sourceIdsWithRevisions?: unknown;
  actorMembershipId?: number | null;
  latencyMs?: number;
}

function buildDb(hasContent: boolean) {
  const insertedRows: InsertedRow[] = [];
  const db: Record<string, unknown> = {
    execute: jest.fn().mockResolvedValue(hasContent ? [{ one: 1 }] : []),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((row: InsertedRow) => {
        insertedRows.push(row);
        return Promise.resolve([]);
      }),
    })),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ id: 1 }]),
      }),
    }),
  };
  db.transaction = jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  return { db: db as unknown as Db, insertedRows };
}

const articleResult = {
  kind: "article" as const,
  id: 42,
  title: "Acme doc",
  slug: "acme-doc",
  spaceId: 1,
  contentText: "relevant text",
  updatedAt: new Date("2024-01-01"),
};

function buildSearch(article = articleResult) {
  return {
    aclCacheOutcome: jest.fn().mockResolvedValue("bypass"),
    retrieveTopArticles: jest.fn().mockResolvedValue([article]),
    retrieveTopSources: jest.fn().mockResolvedValue([]),
    retrieveDocumentPassages: jest.fn().mockResolvedValue([]),
    articleOwnerFilterFor: jest.fn().mockResolvedValue(null),
  };
}

function buildCitationVisibility(articleIds: number[]) {
  return {
    visibleArticles: jest.fn().mockResolvedValue(new Set(articleIds)),
    visiblePages: jest.fn().mockResolvedValue(new Set<number>()),
    visibleSources: jest.fn().mockResolvedValue(new Set<number>()),
  };
}

describe("Ask observability — interaction row reconstruction", () => {
  it("a single correlation_id locates every piece of data for one Ask: interaction row, events, sources, cost", async () => {
    const { db, insertedRows } = buildDb(true);
    const eventCalls: Array<{ orgId: string; eventType: string; options: Record<string, unknown> }> = [];
    const events = {
      record: jest.fn().mockImplementation((orgId: string, eventType: string, options: Record<string, unknown>) => {
        eventCalls.push({ orgId, eventType, options });
        return Promise.resolve();
      }),
    };
    const gateway = {
      invokeTextWithUsage: jest.fn().mockResolvedValue({
        ok: true,
        data: "Here is the answer.",
        correlationId: "gw-corr-reconstruct",
        aiUsage: { model: "gpt-4o-mini", promptTokens: 20, completionTokens: 8, totalTokens: 28, credits: 3, costUsd: 0.002 },
      }),
    };

    const svc = new KbAskService(
      db,
      gateway as never,
      events as never,
      buildSearch() as never,
      buildCitationVisibility([42]) as never,
      NO_LINKED_DOCUMENTS, null,
    );

    await svc.ask(user, { question: "What is the acme doc?" });

    const interactionRow = insertedRows.find((r) => r.correlationId !== undefined);
    expect(interactionRow).toBeDefined();

    const correlationId = interactionRow?.correlationId;
    expect(typeof correlationId).toBe("string");
    expect(correlationId?.length).toBeGreaterThan(0);

    expect(interactionRow?.resultState).toBe("answered");
    expect(interactionRow?.promptTokens).toBe(20);
    expect(interactionRow?.completionTokens).toBe(8);
    expect(interactionRow?.totalTokens).toBe(28);
    expect(interactionRow?.costCredits).toBe(3);
    expect(interactionRow?.model).toBe("gpt-4o-mini");
    expect(interactionRow?.gatewayCorrelationId).toBe("gw-corr-reconstruct");

    const sources = interactionRow?.sourceIdsWithRevisions as Array<{ kind: string; id: number }> | undefined;
    expect(Array.isArray(sources)).toBe(true);
    expect(sources?.some((s) => s.kind === "article" && s.id === 42)).toBe(true);

    const answerEvent = eventCalls.find((e) => e.eventType === "ai_answer");
    expect(answerEvent).toBeDefined();
    expect(answerEvent?.options["correlationId"]).toBe(correlationId);
  });

  it("an interrupted Ask (provider failure mid-flight) leaves a terminal row — not a dangling partial state", async () => {
    const { db, insertedRows } = buildDb(true);
    const events = { record: jest.fn().mockResolvedValue(undefined) };
    const gateway = {
      invokeTextWithUsage: jest.fn().mockResolvedValue({
        ok: false,
        kind: "provider_unavailable",
        message: "Circuit breaker open",
        correlationId: "gw-fail-corr",
      }),
    };

    const svc = new KbAskService(
      db,
      gateway as never,
      events as never,
      buildSearch() as never,
      buildCitationVisibility([42]) as never,
      NO_LINKED_DOCUMENTS, null,
    );

    const result = await svc.ask(user, { question: "What is this?" });

    expect(result.hasContext).toBe(true);

    const interactionRow = insertedRows.find((r) => r.resultState === "provider_unavailable");
    expect(interactionRow).toBeDefined();
    expect(typeof interactionRow?.correlationId).toBe("string");
    expect(interactionRow?.gatewayCorrelationId).toBe("gw-fail-corr");
  });

  it("a credits_exhausted failure writes a terminal row before the 402 propagates", async () => {
    const { db, insertedRows } = buildDb(true);
    const events = { record: jest.fn().mockResolvedValue(undefined) };
    const gateway = {
      invokeTextWithUsage: jest.fn().mockResolvedValue({
        ok: false,
        kind: "quota_exceeded",
        message: "Monthly limit reached",
        correlationId: "gw-quota-corr",
      }),
    };

    const svc = new KbAskService(
      db,
      gateway as never,
      events as never,
      buildSearch() as never,
      buildCitationVisibility([42]) as never,
      NO_LINKED_DOCUMENTS, null,
    );

    await expect(svc.ask(user, { question: "test?" })).rejects.toThrow(InsufficientAiCreditsException);

    const interactionRow = insertedRows.find((r) => r.resultState === "credits_exhausted");
    expect(interactionRow).toBeDefined();
    expect(typeof interactionRow?.correlationId).toBe("string");
    expect(interactionRow?.gatewayCorrelationId).toBe("gw-quota-corr");
  });

  it("correlation_ids are unique per Ask — two concurrent Asks never share the same id", async () => {
    const { db, insertedRows } = buildDb(true);
    const events = { record: jest.fn().mockResolvedValue(undefined) };
    const gateway = {
      invokeTextWithUsage: jest.fn().mockResolvedValue({
        ok: true,
        data: "answer",
        correlationId: "gw-shared",
        aiUsage: { model: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2, credits: 0, costUsd: 0 },
      }),
    };

    const svc = new KbAskService(
      db,
      gateway as never,
      events as never,
      buildSearch() as never,
      buildCitationVisibility([42]) as never,
      NO_LINKED_DOCUMENTS, null,
    );

    await Promise.all([
      svc.ask(user, { question: "q1?" }),
      svc.ask(user, { question: "q2?" }),
    ]);

    const interactionRows = insertedRows.filter((r) => r.correlationId !== undefined);
    expect(interactionRows).toHaveLength(2);
    const ids = interactionRows.map((r) => r.correlationId);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
