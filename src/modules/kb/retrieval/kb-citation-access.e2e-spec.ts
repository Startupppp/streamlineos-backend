import { INestApplication, NotFoundException } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { KbAskService } from "./kb-ask.service";
import { KbChatHistoryService } from "./kb-chat-history.service";
import { KbIndexingService } from "./kb-indexing.service";
import { KbResearchBriefService } from "./kb-research-brief.service";

const READABLE_PAGE_TITLE = "Onboarding checklist";
const RESTRICTED_PAGE_TITLE = "Board compensation memo";
const UPDATED_AT = new Date("2026-01-05T10:00:00.000Z");

const readableCitation = {
  kind: "page" as const,
  pageId: 7,
  title: READABLE_PAGE_TITLE,
  spaceId: 3,
  updatedAt: UPDATED_AT,
};

const NO_CONTEXT_ANSWER =
  "I couldn't find anything about that in the knowledge base. You may want to open a support ticket.";

const askService = {
  ask: jest.fn(),
  streamAsk: jest.fn(),
  assertReplayCitations: jest.fn(),
};

const historyService = {
  createConversation: jest.fn().mockResolvedValue({ id: 1 }),
  appendToConversation: jest.fn().mockResolvedValue(undefined),
  listMessages: jest.fn().mockResolvedValue({ messages: [], nextCursor: null }),
  list: jest.fn().mockResolvedValue({ messages: [], nextCursor: null }),
  clear: jest.fn().mockResolvedValue(undefined),
  listConversations: jest.fn().mockResolvedValue({ conversations: [], nextCursor: null }),
  renameConversation: jest.fn(),
  deleteConversation: jest.fn().mockResolvedValue(undefined),
};

const briefService = {
  enqueue: jest.fn(),
  list: jest.fn(),
  getById: jest.fn(),
  rateBrief: jest.fn(),
};

/**
 * Every provider round trip in this module goes through the gateway, so a stub that
 * records and refuses is what makes "no test reached a real model" an assertion rather
 * than a hope. The counter is read in the last case of the suite.
 */
const gatewayCalls: string[] = [];
function refuse(method: string): () => never {
  return () => {
    gatewayCalls.push(method);
    throw new Error(`AiGatewayService.${method} must not be reached from an e2e test`);
  };
}
const aiGatewayStub = {
  invokeText: refuse("invokeText"),
  invokeTextWithUsage: refuse("invokeTextWithUsage"),
  streamTextWithUsage: refuse("streamTextWithUsage"),
  invokeStructured: refuse("invokeStructured"),
  invokeStructuredWithUsage: refuse("invokeStructuredWithUsage"),
  invokeStructuredWithImage: refuse("invokeStructuredWithImage"),
  invokeStructuredWithImageWithUsage: refuse("invokeStructuredWithImageWithUsage"),
  embedQueryWithCredit: refuse("embedQueryWithCredit"),
  embedBatchWithCredit: refuse("embedBatchWithCredit"),
  isEmbeddingConfigured: (): boolean => false,
};

describe("KB citation access over HTTP (e2e)", () => {
  let app: INestApplication;
  let keySeq = 0;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: KbAskService, useValue: askService },
        { provide: KbChatHistoryService, useValue: historyService },
        { provide: KbResearchBriefService, useValue: briefService },
        { provide: KbIndexingService, useValue: {} },
        { provide: AiGatewayService, useValue: aiGatewayStub },
      ],
    });
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    askService.ask.mockReset();
    askService.assertReplayCitations.mockReset();
    briefService.getById.mockReset();
  });

  function idempotencyKey(): string {
    keySeq += 1;
    return `kb-citation-access-${keySeq}`;
  }

  async function reader(): Promise<string> {
    return signToken({ permissions: ["kb:pages:view"], enabledModules: ["kb"] });
  }

  /**
   * A conversation id is supplied on every ask below. Without one the handler opens a
   * tenant transaction to create the conversation before it reaches the service under
   * test, which is a database round trip this suite has no fixture for.
   */
  function ask(token: string, body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .post("/kb/ask")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idempotencyKey())
      .send({ conversationId: 1, ...body });
  }

  it("401 on POST /kb/ask without a token", async () => {
    const res = await request(app.getHttpServer()).post("/kb/ask").send({ question: "leave policy" });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("403 on POST /kb/ask without kb:pages:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["kb"] });
    const res = await ask(token, { question: "leave policy" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    expect(askService.ask).not.toHaveBeenCalled();
  });

  it("400 on POST /kb/ask without an Idempotency-Key, so a retry cannot re-charge the answer", async () => {
    const token = await reader();
    const res = await request(app.getHttpServer())
      .post("/kb/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ question: "leave policy", conversationId: 1 });
    expect(res.status).toBe(400);
    expect(askService.ask).not.toHaveBeenCalled();
  });

  it("400 when the body tries to name the tenant the retrieval runs against", async () => {
    const token = await reader();
    const res = await ask(token, { question: "leave policy", orgId: "org_2" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(askService.ask).not.toHaveBeenCalled();
  });

  it("answers from the token's identity, never from anything the client sent", async () => {
    askService.ask.mockResolvedValue({
      answer: "Start with the checklist.",
      citations: [readableCitation],
      hasContext: true,
    });
    const token = await reader();

    const res = await ask(token, { question: "how do I onboard" });

    expect(res.status).toBe(200);
    expect(askService.ask).toHaveBeenCalledTimes(1);
    const [user, body] = askService.ask.mock.calls[0] ?? [];
    expect(user).toMatchObject({ orgId: "org_1", userId: "user_1" });
    expect(body).toEqual({ question: "how do I onboard", conversationId: 1 });
  });

  it("serves a citation the reader can open, in the shape the ask contract declares", async () => {
    askService.ask.mockResolvedValue({
      answer: "Start with the checklist.",
      citations: [readableCitation],
      hasContext: true,
    });
    const token = await reader();

    const res = await ask(token, { question: "how do I onboard" });

    expect(res.status).toBe(200);
    expect(res.body.hasContext).toBe(true);
    expect(res.body.conversationId).toBe(1);
    expect(res.body.citations).toEqual([
      {
        kind: "page",
        pageId: 7,
        title: READABLE_PAGE_TITLE,
        spaceId: 3,
        updatedAt: UPDATED_AT.toISOString(),
      },
    ]);
  });

  it("returns the no-context answer, with no citation and no prose, when nothing cited is readable", async () => {
    askService.ask.mockResolvedValue({
      answer: NO_CONTEXT_ANSWER,
      citations: [],
      hasContext: false,
    });
    const token = await reader();

    const res = await ask(token, { question: "what does the board memo say" });

    expect(res.status).toBe(200);
    expect(res.body.hasContext).toBe(false);
    expect(res.body.citations).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain(RESTRICTED_PAGE_TITLE);
  });

  it("401 on GET /kb/research-briefs/:briefId without a token", async () => {
    const res = await request(app.getHttpServer()).get("/kb/research-briefs/1");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("403 on GET /kb/research-briefs/:briefId without kb:pages:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["kb"] });
    const res = await request(app.getHttpServer())
      .get("/kb/research-briefs/1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    expect(briefService.getById).not.toHaveBeenCalled();
  });

  it("serves a stored brief with its citations while the reader can still open them", async () => {
    briefService.getById.mockResolvedValue({
      id: 4,
      orgId: "org_1",
      userId: "user_1",
      topic: "Onboarding",
      spaceId: 3,
      status: "complete",
      jobId: 9,
      sourceCount: 1,
      errorMessage: null,
      rating: null,
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
      report: "The checklist covers the first week.",
      citations: [
        {
          kind: "page",
          id: 7,
          title: READABLE_PAGE_TITLE,
          href: "/kb/pages/7",
          updatedAt: UPDATED_AT.toISOString(),
        },
      ],
    });
    const token = await reader();

    const res = await request(app.getHttpServer())
      .get("/kb/research-briefs/4")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.report).toBe("The checklist covers the first week.");
    expect(res.body.citations).toHaveLength(1);
    expect(briefService.getById).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", userId: "user_1" }),
      4,
    );
  });

  it("withholds the whole brief — report included — once a cited document stops being readable", async () => {
    briefService.getById.mockRejectedValue(
      new NotFoundException("This research brief is no longer accessible"),
    );
    const token = await reader();

    const res = await request(app.getHttpServer())
      .get("/kb/research-briefs/4")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      code: "NOT_FOUND",
      message: "This research brief is no longer accessible",
    });
    expect(res.body).not.toHaveProperty("report");
    expect(res.body).not.toHaveProperty("citations");
  });

  it("never reached a model provider", () => {
    expect(gatewayCalls).toEqual([]);
  });
});
