import { NO_TENANT_TRANSACTION } from "../../common/tenant/no-tenant-transaction.decorator";
import { getTenantContext } from "../../common/tenant/tenant-context";
import { primeRelocationTrafficTracker } from "../../common/relocation/relocation-traffic-tracker";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import type { Db } from "../../db/drizzle.module";
import type { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import type { MailService } from "./mail.service";
import { MailController } from "./mail.controller";
import { MailAiService } from "./mail-ai.service";

const ACTOR: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "ADMIN",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

const THREAD = [
  {
    id: "message-1",
    threadId: "thread-1",
    accountId: 10,
    provider: "gmail" as const,
    from: { name: "Alice", email: "alice@example.com" },
    to: [{ name: null, email: "user@example.com" }],
    cc: [],
    subject: "Status",
    snippet: "Status update",
    bodyHtml: "<p>Status update</p>",
    bodyText: "Status update",
    date: "2026-09-20T00:00:00.000Z",
    isRead: false,
    isStarred: false,
    hasAttachments: false,
    attachments: [],
  },
];

interface Trace {
  transactionDepth: number;
  transactions: number;
  dbDepths: number[];
  providerDepths: number[];
}

function tracingDb(trace: Trace): Db {
  const db = {
    execute: async () => {
      trace.dbDepths.push(trace.transactionDepth);
      return [];
    },
    transaction: async <T>(run: (tx: Db) => Promise<T>): Promise<T> => {
      trace.transactions += 1;
      trace.transactionDepth += 1;
      try {
        return await run(db as unknown as Db);
      } finally {
        trace.transactionDepth -= 1;
      }
    },
  };

  return db as unknown as Db;
}

function mailThatRecordsDepth(trace: Trace, messages = THREAD): MailService {
  return {
    getThread: async () => {
      trace.dbDepths.push(trace.transactionDepth);
      if (!getTenantContext()) throw new Error("42501: mail read ran without tenant context");
      return messages;
    },
  } as unknown as MailService;
}

function gatewayThatRecordsDepth(
  trace: Trace,
  outcome: "success" | "provider_failure" = "success",
): AiGatewayService {
  return {
    invokeStructured: async (request: { feature: string }) => {
      trace.providerDepths.push(trace.transactionDepth);
      if (getTenantContext()) throw new Error("provider invoked inside tenant transaction");
      if (outcome === "provider_failure")
        return {
          ok: false as const,
          kind: "provider_unavailable" as const,
          message: "Provider unavailable",
          correlationId: "correlation-1",
        };
      return request.feature === "mail.thread-summary"
        ? {
            ok: true as const,
            data: { summary: "Summary", actionItems: [], suggestedReply: "" },
            model: "fast",
            latencyMs: 1,
            correlationId: "correlation-1",
            usage: {},
          }
        : {
            ok: true as const,
            data: { subject: "Subject", bodyHtml: "<p>Body</p>" },
            model: "fast",
            latencyMs: 1,
            correlationId: "correlation-1",
            usage: {},
          };
    },
  } as unknown as AiGatewayService;
}

function makeTrace(): Trace {
  return {
    transactionDepth: 0,
    transactions: 0,
    dbDepths: [],
    providerDepths: [],
  };
}

function makeService(
  trace: Trace,
  messages = THREAD,
  outcome: "success" | "provider_failure" = "success",
): MailAiService {
  return new MailAiService(
    tracingDb(trace),
    mailThatRecordsDepth(trace, messages),
    gatewayThatRecordsDepth(trace, outcome),
  );
}

describe("mail AI connection hold", () => {
  beforeEach(() => primeRelocationTrafficTracker([], Date.now()));

  it.each(["aiDraft", "aiThreadSummary"] as const)(
    "opts %s out of the request-wide tenant transaction",
    (handler) => {
      expect(
        Reflect.getMetadata(NO_TENANT_TRANSACTION, MailController.prototype[handler]),
      ).toBe(true);
    },
  );

  it("leaves inbox summary on the request-wide tenant transaction", () => {
    expect(
      Reflect.getMetadata(NO_TENANT_TRANSACTION, MailController.prototype.aiInboxSummary),
    ).toBeUndefined();
  });

  it("reads a thread in one short transaction and invokes its provider at depth zero", async () => {
    const trace = makeTrace();

    await makeService(trace).threadSummary(ACTOR, 10, "thread-1");

    expect(trace.dbDepths.length).toBeGreaterThan(0);
    expect(trace.dbDepths.every((depth) => depth === 1)).toBe(true);
    expect(trace.providerDepths).toEqual([0]);
    expect(trace.transactions).toBe(1);
    expect(trace.transactionDepth).toBe(0);
  });

  it("reads reply context in one short transaction and invokes its provider at depth zero", async () => {
    const trace = makeTrace();

    await makeService(trace).draft(ACTOR, {
      mode: "reply",
      instruction: "Reply politely",
      accountId: 10,
      threadId: "thread-1",
    });

    expect(trace.dbDepths.length).toBeGreaterThan(0);
    expect(trace.dbDepths.every((depth) => depth === 1)).toBe(true);
    expect(trace.providerDepths).toEqual([0]);
    expect(trace.transactions).toBe(1);
    expect(trace.transactionDepth).toBe(0);
  });

  it("returns an empty thread without invoking the provider or retaining a connection", async () => {
    const trace = makeTrace();

    const result = await makeService(trace, []).threadSummary(ACTOR, 10, "thread-1");

    expect(result).toEqual({
      summary: "This thread has no messages.",
      actionItems: [],
      suggestedReply: "",
    });
    expect(trace.providerDepths).toEqual([]);
    expect(trace.transactions).toBe(1);
    expect(trace.transactionDepth).toBe(0);
  });

  it("releases the read transaction before a provider failure", async () => {
    const trace = makeTrace();

    await expect(
      makeService(trace, THREAD, "provider_failure").threadSummary(ACTOR, 10, "thread-1"),
    ).rejects.toBeDefined();

    expect(trace.providerDepths).toEqual([0]);
    expect(trace.transactions).toBe(1);
    expect(trace.transactionDepth).toBe(0);
  });
});
