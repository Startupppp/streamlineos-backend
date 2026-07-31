jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { HttpException, HttpStatus, ServiceUnavailableException } from "@nestjs/common";
import { MailAiService } from "./mail-ai.service";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import type { MailService } from "./mail.service";
import type { AiInvokeResult, AiInvokeWithUsageResult, AiUsageMeta } from "../ai/core/gateway/ai-gateway.types";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

const ACTOR: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  branchId: null,
  role: "ADMIN",
  permissions: [],
  enabledModules: [],
  plan: "PROFESSIONAL",
  isOrgOwner: false,
  sessionId: "sess-1",
};

const MOCK_MESSAGES = [
  {
    id: "msg-1",
    threadId: "thread-1",
    accountId: 10,
    provider: "gmail" as const,
    from: { name: "Alice", email: "alice@example.com" },
    to: [{ name: null, email: "me@example.com" }],
    subject: "Project update",
    snippet: "Hey, just wanted to share the latest update on the project.",
    date: "2026-07-19T10:00:00Z",
    isRead: false,
    isStarred: false,
    hasAttachments: false,
  },
];

const MOCK_THREAD_MESSAGES = [
  {
    ...MOCK_MESSAGES[0],
    cc: [],
    bodyHtml: "<p>Hey, just wanted to share the latest update on the project.</p>",
    bodyText: "Hey, just wanted to share the latest update on the project.",
    attachments: [],
  },
];

const INBOX_SUMMARY_RESULT = {
  summary: "You have 1 unread email about a project update.",
  highlights: [{ subject: "Project update", fromEmail: "alice@example.com", reason: "Unread, important update" }],
  actionItems: ["Reply to Alice about project update"],
};

const THREAD_SUMMARY_RESULT = {
  summary: "Alice shared a project update.",
  actionItems: ["Review update", "Reply to Alice"],
  suggestedReply: "Thanks Alice, I will review this shortly.",
};

const DRAFT_RESULT = {
  subject: "Re: Project update",
  bodyHtml: "<p>Thanks for the update!</p>",
};

const MOCK_AI_USAGE: AiUsageMeta = {
  model: "gpt-4o-mini",
  promptTokens: 50,
  completionTokens: 100,
  totalTokens: 150,
  credits: 1,
  costUsd: 0.001,
};

function makeGatewaySuccess(data: unknown): AiInvokeResult<unknown> {
  return {
    ok: true,
    data,
    model: "gpt-4o-mini",
    latencyMs: 100,
    correlationId: "corr-1",
    usage: { promptTokens: 50, completionTokens: 100, totalTokens: 150 },
  };
}

function makeGatewayFail(kind: "quota_exceeded" | "provider_unavailable" | "not_configured" | "invalid_output"): AiInvokeResult<never> {
  return { ok: false, kind, message: kind === "quota_exceeded" ? "Insufficient AI credits" : "Provider unavailable", correlationId: "corr-err" };
}

function toWithUsageResult(result: AiInvokeResult<unknown>): AiInvokeWithUsageResult<unknown> {
  if (!result.ok) return result;
  return { ok: true, data: result.data, aiUsage: MOCK_AI_USAGE };
}

function makeGateway(result: AiInvokeResult<unknown>): jest.Mocked<AiGatewayService> {
  return {
    invokeStructured: jest.fn().mockResolvedValue(result),
    invokeStructuredWithUsage: jest.fn().mockResolvedValue(toWithUsageResult(result)),
    invokeText: jest.fn(),
    invokeTextWithUsage: jest.fn(),
  } as unknown as jest.Mocked<AiGatewayService>;
}

function makeMailService(overrides: Partial<{
  listMessages: jest.Mock;
  getThread: jest.Mock;
}> = {}): jest.Mocked<MailService> {
  return {
    listMessages: overrides.listMessages ?? jest.fn().mockResolvedValue({ messages: MOCK_MESSAGES, nextCursor: null, accountErrors: [] }),
    getThread: overrides.getThread ?? jest.fn().mockResolvedValue(MOCK_THREAD_MESSAGES),
  } as unknown as jest.Mocked<MailService>;
}

function makeService(gateway: jest.Mocked<AiGatewayService>, mailSvc: jest.Mocked<MailService>): MailAiService {
  return new MailAiService(mailSvc, gateway);
}

describe("MailAiService", () => {
  describe("inboxSummary", () => {
    it("returns empty result without calling gateway when inbox has zero messages", async () => {
      const gateway = makeGateway(makeGatewaySuccess(INBOX_SUMMARY_RESULT));
      const mailSvc = makeMailService({
        listMessages: jest.fn().mockResolvedValue({ messages: [], nextCursor: null, accountErrors: [] }),
      });
      const svc = makeService(gateway, mailSvc);

      const result = await svc.inboxSummary(ACTOR);

      expect(result.summary).toBe("Your inbox is empty.");
      expect(result.highlights).toHaveLength(0);
      expect(result.actionItems).toHaveLength(0);
      expect(gateway.invokeStructuredWithUsage).not.toHaveBeenCalled();
      expect(gateway.invokeStructured).not.toHaveBeenCalled();
    });

    it("returns summary from gateway on happy path", async () => {
      const gateway = makeGateway(makeGatewaySuccess(INBOX_SUMMARY_RESULT));
      const svc = makeService(gateway, makeMailService());

      const result = await svc.inboxSummary(ACTOR, "all");

      expect(result.summary).toBe(INBOX_SUMMARY_RESULT.summary);
      expect(result.highlights).toHaveLength(1);
      expect(result.aiUsage).toEqual(MOCK_AI_USAGE);
      expect(gateway.invokeStructuredWithUsage).toHaveBeenCalledTimes(1);
    });

    it("propagates quota_exceeded as 402 Payment Required", async () => {
      const gateway = makeGateway(makeGatewayFail("quota_exceeded"));
      const svc = makeService(gateway, makeMailService());

      try {
        await svc.inboxSummary(ACTOR);
        throw new Error("expected quota failure");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
      }
    });

    it("propagates provider_unavailable as ServiceUnavailableException", async () => {
      const gateway = makeGateway(makeGatewayFail("provider_unavailable"));
      const svc = makeService(gateway, makeMailService());

      await expect(svc.inboxSummary(ACTOR)).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe("threadSummary", () => {
    it("returns empty result without calling gateway when thread has zero messages", async () => {
      const gateway = makeGateway(makeGatewaySuccess(THREAD_SUMMARY_RESULT));
      const mailSvc = makeMailService({ getThread: jest.fn().mockResolvedValue([]) });
      const svc = makeService(gateway, mailSvc);

      const result = await svc.threadSummary(ACTOR, 10, "thread-1");

      expect(result.summary).toBe("This thread has no messages.");
      expect(result.actionItems).toHaveLength(0);
      expect(result.suggestedReply).toBe("");
      expect(gateway.invokeStructured).not.toHaveBeenCalled();
    });

    it("returns thread summary on happy path", async () => {
      const gateway = makeGateway(makeGatewaySuccess(THREAD_SUMMARY_RESULT));
      const svc = makeService(gateway, makeMailService());

      const result = await svc.threadSummary(ACTOR, 10, "thread-1");

      expect(result.summary).toBe(THREAD_SUMMARY_RESULT.summary);
      expect(result.actionItems).toEqual(THREAD_SUMMARY_RESULT.actionItems);
      expect(gateway.invokeStructured).toHaveBeenCalledTimes(1);
    });

    it("propagates quota_exceeded as 402 Payment Required", async () => {
      const gateway = makeGateway(makeGatewayFail("quota_exceeded"));
      const svc = makeService(gateway, makeMailService());

      try {
        await svc.threadSummary(ACTOR, 10, "thread-1");
        throw new Error("expected quota failure");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
      }
    });
  });

  describe("draft", () => {
    it("generates compose draft without thread context", async () => {
      const gateway = makeGateway(makeGatewaySuccess(DRAFT_RESULT));
      const mailSvc = makeMailService();
      const svc = makeService(gateway, mailSvc);

      const result = await svc.draft(ACTOR, { mode: "compose", instruction: "Write a follow-up email" });

      expect(result.subject).toBe(DRAFT_RESULT.subject);
      expect(result.bodyHtml).toBe(DRAFT_RESULT.bodyHtml);
      expect(mailSvc.getThread).not.toHaveBeenCalled();
      expect(gateway.invokeStructured).toHaveBeenCalledTimes(1);
    });

    it("fetches thread context when mode is reply and accountId + threadId provided", async () => {
      const gateway = makeGateway(makeGatewaySuccess(DRAFT_RESULT));
      const mailSvc = makeMailService();
      const svc = makeService(gateway, mailSvc);

      await svc.draft(ACTOR, { mode: "reply", instruction: "Write a polite reply", accountId: 10, threadId: "thread-1" });

      expect(mailSvc.getThread).toHaveBeenCalledWith("org-1", "user-1", "thread-1", 10);
    });

    it("propagates quota_exceeded as 402 Payment Required", async () => {
      const gateway = makeGateway(makeGatewayFail("quota_exceeded"));
      const svc = makeService(gateway, makeMailService());

      try {
        await svc.draft(ACTOR, { mode: "compose", instruction: "Draft something" });
        throw new Error("expected quota failure");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
      }
    });
  });
});
