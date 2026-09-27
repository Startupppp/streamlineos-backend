import { KbAskService } from "./kb-ask.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { NO_LINKED_DOCUMENTS } from "../../../test/kb-linked-document-ask-source.spec-fixtures";
import type { Db } from "../../../db/drizzle.module";
import type { AiStreamTextOpts } from "../../ai/core/gateway/ai-gateway-stream.helper";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, handle: (tx: unknown) => Promise<unknown>) => handle(db),
}));

const user = {
  userId: "user-parity",
  orgId: "org-parity",
  role: "member" as const,
  isOrgOwner: false,
  sessionId: "sess-parity",
  tokenScopes: null,
  principal: humanSessionPrincipal(7, false),
};

interface InsertedRow {
  orgId?: string;
  correlationId?: string;
  resultState?: string;
  model?: string;
  provider?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costCredits?: number;
  latencyMs?: number;
  gatewayCorrelationId?: string;
  sourceIdsWithRevisions?: unknown;
  actorMembershipId?: number | null;
}

function buildDb() {
  const insertedRows: InsertedRow[] = [];
  const db: Record<string, unknown> = {
    execute: jest.fn().mockResolvedValue([{ one: 1 }]),
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

const articleFixture = {
  kind: "article" as const,
  id: 42,
  title: "Parity article",
  slug: "parity-article",
  spaceId: 1,
  contentText: "relevant text for parity testing",
  updatedAt: new Date("2024-01-01"),
};

function buildRetrieval() {
  return {
    retrieve: jest.fn().mockResolvedValue({
      documents: [articleFixture],
      sources: [],
      passages: [],
      degraded: { kind: "none" as const },
      strategy: { kind: "exact" as const },
    }),
  };
}

function buildCitationsService() {
  return {
    resolveCitations: jest.fn().mockResolvedValue([{
      kind: "article" as const,
      articleId: articleFixture.id,
      title: articleFixture.title,
      slug: articleFixture.slug,
      spaceId: articleFixture.spaceId,
      updatedAt: articleFixture.updatedAt,
    }]),
    stillCitableDocuments: jest.fn().mockResolvedValue([]),
  };
}

function buildEvents() {
  return { record: jest.fn().mockResolvedValue(undefined) };
}

const GATEWAY_USAGE = {
  model: "gpt-4o-mini",
  provider: "openai",
  promptTokens: 20,
  completionTokens: 8,
  totalTokens: 28,
  credits: 3,
  costUsd: 0.002,
};

function buildNonStreamingGateway() {
  return {
    invokeTextWithUsage: jest.fn().mockResolvedValue({
      ok: true,
      data: "Non-streaming answer",
      correlationId: "gw-non-stream-corr",
      aiUsage: GATEWAY_USAGE,
    }),
  };
}

function buildStreamingGateway() {
  return {
    streamTextWithUsage: jest.fn().mockImplementation(async (opts: AiStreamTextOpts) => {
      await opts.onCompleted?.({
        text: "Streaming answer",
        promptTokens: GATEWAY_USAGE.promptTokens,
        completionTokens: GATEWAY_USAGE.completionTokens,
        model: GATEWAY_USAGE.model,
        provider: GATEWAY_USAGE.provider,
        costCredits: GATEWAY_USAGE.credits,
        gatewayCorrelationId: "gw-stream-corr",
      });
      return { model: GATEWAY_USAGE.model, correlationId: "gw-stream-corr", stream: {} };
    }),
  };
}

async function captureAskRow(): Promise<InsertedRow> {
  const { db, insertedRows } = buildDb();
  const svc = new KbAskService(
    db,
    buildNonStreamingGateway() as never,
    buildEvents() as never,
    { aclCacheOutcome: jest.fn().mockResolvedValue("bypass") } as never,
    buildCitationsService() as never,
    NO_LINKED_DOCUMENTS,
    null,
    buildRetrieval() as never,
  );
  await svc.ask(user, { question: "What is parity?" });
  const row = insertedRows.find((r) => r.resultState === "answered");
  if (row === undefined) throw new Error("ask() did not write an answered interaction row");
  return row;
}

async function captureStreamAskRow(): Promise<InsertedRow> {
  const { db, insertedRows } = buildDb();
  const svc = new KbAskService(
    db,
    buildStreamingGateway() as never,
    buildEvents() as never,
    { aclCacheOutcome: jest.fn().mockResolvedValue("bypass") } as never,
    buildCitationsService() as never,
    NO_LINKED_DOCUMENTS,
    null,
    buildRetrieval() as never,
  );
  await svc.streamAsk(user, { question: "What is parity?" }, new AbortController().signal);
  const row = insertedRows.find((r) => r.resultState === "answered");
  if (row === undefined) throw new Error("streamAsk() onCompleted did not write an answered interaction row");
  return row;
}

describe("kb_ai_interactions — streaming vs non-streaming answered-path field parity", () => {
  let askRow: InsertedRow;
  let streamRow: InsertedRow;

  beforeAll(async () => {
    askRow = await captureAskRow();
    streamRow = await captureStreamAskRow();
  });

  it("both paths write an answered interaction row — positive control confirming both captures are live and not mocked away", () => {
    expect(askRow.resultState).toBe("answered");
    expect(streamRow.resultState).toBe("answered");
  });

  it("streaming onCompleted writes exactly the same field set as the non-streaming path — a field added to one path only fails here", () => {
    const askFields = Object.keys(askRow).sort();
    const streamFields = Object.keys(streamRow).sort();
    expect(streamFields).toEqual(askFields);
  });

  it("model carries the same value in both paths for the same provider response", () => {
    expect(streamRow.model).toBeDefined();
    expect(streamRow.model).toBe(askRow.model);
  });

  it("provider carries the same non-null value in both paths — an always-null provider column would pass field-set parity while recording nothing", () => {
    expect(streamRow.provider).toBe("openai");
    expect(streamRow.provider).toBe(askRow.provider);
  });

  it("promptTokens carries the same value in both paths for the same provider response", () => {
    expect(streamRow.promptTokens).toBeDefined();
    expect(streamRow.promptTokens).toBe(askRow.promptTokens);
  });

  it("completionTokens carries the same value in both paths for the same provider response", () => {
    expect(streamRow.completionTokens).toBeDefined();
    expect(streamRow.completionTokens).toBe(askRow.completionTokens);
  });

  it("totalTokens carries the same value in both paths for the same provider response", () => {
    expect(streamRow.totalTokens).toBeDefined();
    expect(streamRow.totalTokens).toBe(askRow.totalTokens);
  });

  it("costCredits carries the same value in both paths for the same provider response", () => {
    expect(streamRow.costCredits).toBeDefined();
    expect(streamRow.costCredits).toBe(askRow.costCredits);
  });

  it("latencyMs is present as a finite number in both rows — its value legitimately differs between paths as it is a per-call wall-clock duration", () => {
    expect(typeof askRow.latencyMs).toBe("number");
    expect(Number.isFinite(askRow.latencyMs)).toBe(true);
    expect(typeof streamRow.latencyMs).toBe("number");
    expect(Number.isFinite(streamRow.latencyMs)).toBe(true);
  });

  it("gatewayCorrelationId is a non-empty string in both rows — its value legitimately differs per call as it is provider-assigned per invocation", () => {
    expect(typeof askRow.gatewayCorrelationId).toBe("string");
    expect((askRow.gatewayCorrelationId ?? "").length).toBeGreaterThan(0);
    expect(typeof streamRow.gatewayCorrelationId).toBe("string");
    expect((streamRow.gatewayCorrelationId ?? "").length).toBeGreaterThan(0);
  });

  it("correlationId is a non-empty string in both rows — its value legitimately differs per call as it is a per-invocation UUID", () => {
    expect(typeof askRow.correlationId).toBe("string");
    expect((askRow.correlationId ?? "").length).toBeGreaterThan(0);
    expect(typeof streamRow.correlationId).toBe("string");
    expect((streamRow.correlationId ?? "").length).toBeGreaterThan(0);
  });
});
