import { Test } from "@nestjs/testing";
import { HttpException, NotFoundException } from "@nestjs/common";
import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { KbAskController } from "./kb-ask.controller";
import { KbAskService } from "./kb-ask.service";
import { KbChatHistoryService } from "./kb-chat-history.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { COMMAND_FENCE_STORE } from "../../../common/idempotency/command-fence-store";
import { InMemoryCommandFenceStore } from "../../../common/idempotency/command-fence-store-memory";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, handle: (tx: unknown) => Promise<unknown>) => handle(db),
}));

const user: CurrentUserContext = {
  orgId: "org-a", userId: "user-a", role: "MEMBER", isOrgOwner: false,
  sessionId: "session-a", tokenScopes: null, principal: humanSessionPrincipal(7, false),
};

async function fixture(noContext = false) {
  const history = {
    listMessages: jest.fn().mockResolvedValue({ messages: [], nextCursor: null }),
    createConversation: jest.fn().mockResolvedValue({ id: 42 }),
    appendToConversation: jest.fn().mockResolvedValue(undefined),
  };
  const verifyCitations = jest.fn().mockResolvedValue([]);
  const ask = { assertReplayCitations: jest.fn().mockResolvedValue(undefined), streamAsk: jest.fn().mockResolvedValue(noContext ? { hasContext: false } : {
    hasContext: true, citations: [], verifyCitations,
    aiStream: {
      model: "gpt-4o-mini", correlationId: "test-call",
      stream: {
        textStream: new ReadableStream<string>({ start(controller) {
          controller.enqueue("Verified answer"); controller.close();
        } }),
        finishReason: Promise.resolve("stop"), text: Promise.resolve("Verified answer"),
        totalUsage: Promise.resolve({ inputTokens: 20, outputTokens: 10, totalTokens: 30 }),
      },
    },
  }) };
  const module = await Test.createTestingModule({ providers: [
    KbAskController, { provide: DRIZZLE, useValue: {} },
    { provide: KbAskService, useValue: ask }, { provide: KbChatHistoryService, useValue: history },
    { provide: COMMAND_FENCE_STORE, useValue: new InMemoryCommandFenceStore() },
  ] })
    .overrideGuard(JwtAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(PermissionGuard).useValue({ canActivate: () => true })
    .overrideGuard(RateLimitGuard).useValue({ canActivate: () => true })
    .compile();
  const controller = module.get(KbAskController);
  const app = express();
  app.use(express.json());
  app.post("/ask", (req, res, next) => {
    void controller.askStream(req, req.body, user, res).catch(next);
  });
  const handleError: ErrorRequestHandler = (error: unknown, req, res, next) => {
    if (res.headersSent) { next(error); return; }
    req.resume();
    res.status(error instanceof HttpException ? error.getStatus() : 500).json({ error: "request failed" });
  };
  app.use(handleError);
  return { app, history, ask, verifyCitations };
}

describe("KB streamed result parity", () => {
  it("rechecks citations and persists both turns before returning conversation metadata", async () => {
    const f = await fixture();
    const response = await request(f.app).post("/ask").set("Idempotency-Key", "attempt-a").send({ question: "How does this work?" });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-ndjson");
    expect(response.text).toContain('"type":"text","text":"Verified answer"');
    expect(response.text).toContain('"conversationId":42');
    expect(response.text).toContain('"aiUsage":');
    expect(f.verifyCitations).toHaveBeenCalledTimes(1);
    expect(f.history.appendToConversation).toHaveBeenNthCalledWith(1, "org-a", "user-a", 7, 42, "user", "How does this work?");
    expect(f.history.appendToConversation).toHaveBeenNthCalledWith(2, "org-a", "user-a", 7, 42, "assistant", "Verified answer", []);
  });

  it("does not dispatch AI for a conversation the caller cannot access", async () => {
    const f = await fixture();
    f.history.listMessages.mockRejectedValue(new NotFoundException("Conversation not found"));
    const response = await request(f.app).post("/ask").set("Idempotency-Key", "attempt-a").send({ question: "Question", conversationId: 999 });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(f.ask.streamAsk).not.toHaveBeenCalled();
    expect(f.history.appendToConversation).not.toHaveBeenCalled();
  });

  it("persists the no-context answer and returns its conversation without fabricated usage", async () => {
    const f = await fixture(true);
    const response = await request(f.app).post("/ask").set("Idempotency-Key", "attempt-a").send({ question: "Question" });
    expect(response.text).toContain('"hasContext":false');
    expect(response.text).toContain('"conversationId":42');
    expect(response.text).not.toContain('"aiUsage"');
    expect(f.history.appendToConversation).toHaveBeenCalledTimes(2);
  });

  it("does not report a durable success when the history transaction fails", async () => {
    const f = await fixture();
    f.history.appendToConversation.mockRejectedValue(new Error("private database detail"));
    const response = await request(f.app).post("/ask").set("Idempotency-Key", "attempt-a").send({ question: "Question" });
    expect(response.text).toContain('"type":"error"');
    expect(response.text).not.toContain('"type":"result"');
    expect(response.text).not.toContain("private database detail");
  });

  it("replays a completed answer without another provider call or duplicate history", async () => {
    const f = await fixture();
    const first = await request(f.app).post("/ask").set("Idempotency-Key", "same-key").send({ question: "Question" });
    const replay = await request(f.app).post("/ask").set("Idempotency-Key", "same-key").send({ question: "Question" });
    expect(replay.status).toBe(200);
    const readFrames = (body: string): unknown[] => body.trim().split("\n").map((line): unknown => JSON.parse(line));
    expect(readFrames(replay.text)).toEqual(readFrames(first.text));
    expect(f.ask.streamAsk).toHaveBeenCalledTimes(1);
    expect(f.history.appendToConversation).toHaveBeenCalledTimes(2);
    expect(f.ask.assertReplayCitations).toHaveBeenCalledTimes(1);
    expect(f.history.listMessages).toHaveBeenCalledWith("org-a", "user-a", 7, 42, { limit: 1 });
  });

  it("fails closed when replay citations were revoked", async () => {
    const f = await fixture();
    await request(f.app).post("/ask").set("Idempotency-Key", "same-key").send({ question: "Question" });
    f.ask.assertReplayCitations.mockRejectedValue(new NotFoundException("Revoked"));
    const replay = await request(f.app).post("/ask").set("Idempotency-Key", "same-key").send({ question: "Question" });
    expect(replay.status).toBe(404);
    expect(replay.text).not.toContain("Verified answer");
    expect(f.ask.streamAsk).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit new key after a started operation fails", async () => {
    const f = await fixture();
    f.ask.streamAsk.mockRejectedValue(new Error("provider failed"));
    await request(f.app).post("/ask").set("Idempotency-Key", "same-key").send({ question: "Question" });
    const retry = await request(f.app).post("/ask").set("Idempotency-Key", "same-key").send({ question: "Question" });
    expect(retry.status).toBe(409);
    expect(f.ask.streamAsk).toHaveBeenCalledTimes(1);
  });
});
