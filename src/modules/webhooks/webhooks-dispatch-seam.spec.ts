/**
 * Verifies that the webhook dispatcher uses callProvider for retry + circuit breaker,
 * postSafeWebhook (pinned DNS) instead of raw fetch, and logs dispatch errors.
 *
 * Bite proof strategy:
 *   I1 — neutering UnsafeWebhookTargetError classification reveals 5 retries instead of 1.
 *   I3 — neutering the logger.error call proves the dispatch error is swallowed.
 */
jest.mock("../../common/outbound/call-provider", () => {
  const actual = jest.requireActual<typeof import("../../common/outbound/call-provider")>(
    "../../common/outbound/call-provider",
  );
  return {
    callProvider: jest.fn(
      (
        ...args: Parameters<typeof actual.callProvider>
      ) => actual.callProvider(...args),
    ),
    ProviderTimeoutError: actual.ProviderTimeoutError,
    providerBackoffMs: actual.providerBackoffMs,
  };
});

jest.mock("../../common/outbound/safe-webhook-transport", () => {
  class UnsafeWebhookTargetError extends Error {
    constructor(readonly reason: string) {
      super(`Blocked webhook target (${reason})`);
      this.name = "UnsafeWebhookTargetError";
    }
  }
  return {
    postSafeWebhook: jest.fn(),
    UnsafeWebhookTargetError,
  };
});

jest.mock("../../common/security/ssrf-guard", () => ({
  checkWebhookUrl: jest.fn().mockResolvedValue({ allowed: true }),
}));

jest.mock("../../common/security/secret-encryption.util", () => ({
  isEncryptedSecret: jest.fn().mockReturnValue(false),
  decryptSecret: jest.fn((s: string) => s),
}));

jest.mock("../../common/logger/logger.service", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { callProvider } from "../../common/outbound/call-provider";
import type { ProviderDescriptor, ProviderCallResult } from "../../common/outbound/call-provider";
import { postSafeWebhook, UnsafeWebhookTargetError } from "../../common/outbound/safe-webhook-transport";
import { logger } from "../../common/logger/logger.service";
import type { Db } from "../../db/drizzle.module";
import {
  WebhooksDispatchService,
  WebhookTerminalStatusError,
  classifyWebhookError,
} from "./webhooks-dispatch.service";

const mockPostSafeWebhook = postSafeWebhook as jest.Mock;
const callProviderSpy = callProvider as jest.Mock;

const ORG = "org-123";
const EVENT = "order.created";
const PAYLOAD = { orderId: "x1" };

const ENDPOINT = {
  id: 7,
  url: "https://example.com/hooks",
  secret: "secret",
  orgId: ORG,
  isActive: true,
  events: [],
  description: null,
  createdBy: "user-1",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const insertedLogs: Record<string, unknown>[] = [];

function makeDb(): Db {
  return {
    query: {
      webhookEndpoints: {
        findMany: jest.fn().mockResolvedValue([ENDPOINT]),
        findFirst: jest.fn().mockResolvedValue(ENDPOINT),
      },
      webhookLogs: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    },
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
        insertedLogs.push(row);
        return Promise.resolve([]);
      }),
    }),
  } as unknown as Db;
}

describe("WebhooksDispatchService — callProvider seam", () => {
  let svc: WebhooksDispatchService;

  beforeEach(() => {
    jest.clearAllMocks();
    insertedLogs.length = 0;
    callProviderSpy.mockImplementation(
      (...args: Parameters<typeof import("../../common/outbound/call-provider").callProvider>) => {
        const actual = jest.requireActual<typeof import("../../common/outbound/call-provider")>(
          "../../common/outbound/call-provider",
        );
        return actual.callProvider(...args);
      },
    );
    svc = new WebhooksDispatchService(makeDb());
  });

  it("classifies 4xx as terminal — exactly 1 postSafeWebhook attempt, log records attempt=1", async () => {
    mockPostSafeWebhook.mockResolvedValueOnce({ statusCode: 400, responseBody: "Bad Request" });

    await (svc as unknown as { run: (o: string, e: string, p: Record<string, unknown>) => Promise<void> }).run(
      ORG, EVENT, PAYLOAD,
    );

    expect(mockPostSafeWebhook).toHaveBeenCalledTimes(1);
    const log = insertedLogs[0];
    expect(log?.["success"]).toBe(false);
    expect(log?.["statusCode"]).toBe(400);
    expect(log?.["attempt"]).toBe(1);
    expect(String(log?.["responseBody"])).toContain("400");
  });

  it("classifies 5xx as retryable — retries up to WEBHOOK_MAX_ATTEMPTS (5)", async () => {
    callProviderSpy.mockImplementation(
      async (desc: ProviderDescriptor, fn: () => Promise<unknown>): Promise<ProviderCallResult<unknown>> => {
        let last: Error = new Error("no attempts");
        for (let i = 1; i <= desc.maxAttempts; i++) {
          try {
            return { ok: true, value: await fn(), attempts: i };
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            last = err;
            if (desc.classify(e) === "terminal")
              return { ok: false, kind: "terminal", error: err, attempts: i };
          }
        }
        return { ok: false, kind: "dead-lettered", error: last, attempts: desc.maxAttempts };
      },
    );

    mockPostSafeWebhook.mockResolvedValue({ statusCode: 503, responseBody: "Service Unavailable" });

    await (svc as unknown as { run: (o: string, e: string, p: Record<string, unknown>) => Promise<void> }).run(
      ORG, EVENT, PAYLOAD,
    );

    expect(mockPostSafeWebhook).toHaveBeenCalledTimes(5);
    const log = insertedLogs[0];
    expect(log?.["success"]).toBe(false);
    expect(log?.["attempt"]).toBe(5);
    expect(String(log?.["responseBody"])).toContain("Dead after 5");
  });

  it("succeeds and writes success=true when endpoint returns 2xx", async () => {
    mockPostSafeWebhook.mockResolvedValueOnce({ statusCode: 200, responseBody: "OK" });

    await (svc as unknown as { run: (o: string, e: string, p: Record<string, unknown>) => Promise<void> }).run(
      ORG, EVENT, PAYLOAD,
    );

    expect(mockPostSafeWebhook).toHaveBeenCalledTimes(1);
    const log = insertedLogs[0];
    expect(log?.["success"]).toBe(true);
    expect(log?.["statusCode"]).toBe(200);
    expect(log?.["attempt"]).toBe(1);
  });

  it("bites: neutering callProvider classify causes 4xx to be retried 5 times", async () => {
    callProviderSpy.mockImplementation(
      async (desc: ProviderDescriptor, fn: () => Promise<unknown>): Promise<ProviderCallResult<unknown>> => {
        let last: Error = new Error("no attempts");
        for (let i = 1; i <= desc.maxAttempts; i++) {
          try {
            return { ok: true, value: await fn(), attempts: i };
          } catch (e) {
            last = e instanceof Error ? e : new Error(String(e));
          }
        }
        return { ok: false, kind: "dead-lettered", error: last, attempts: desc.maxAttempts };
      },
    );

    mockPostSafeWebhook.mockResolvedValue({ statusCode: 400, responseBody: "Bad Request" });

    await (svc as unknown as { run: (o: string, e: string, p: Record<string, unknown>) => Promise<void> }).run(
      ORG, EVENT, PAYLOAD,
    );

    expect(mockPostSafeWebhook).toHaveBeenCalledTimes(5);
  });

  it("I1 — SSRF block from postSafeWebhook is classified terminal — exactly 1 attempt (bite: removes UnsafeWebhookTargetError from classifier → 5 attempts)", async () => {
    callProviderSpy.mockImplementation(
      async (desc: ProviderDescriptor, fn: () => Promise<unknown>): Promise<ProviderCallResult<unknown>> => {
        let last: Error = new Error("no attempts");
        for (let i = 1; i <= desc.maxAttempts; i++) {
          try {
            return { ok: true, value: await fn(), attempts: i };
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            last = err;
            if (desc.classify(e) === "terminal")
              return { ok: false, kind: "terminal", error: err, attempts: i };
          }
        }
        return { ok: false, kind: "dead-lettered", error: last, attempts: desc.maxAttempts };
      },
    );

    mockPostSafeWebhook.mockRejectedValue(new UnsafeWebhookTargetError("blocked-address"));

    await (svc as unknown as { run: (o: string, e: string, p: Record<string, unknown>) => Promise<void> }).run(
      ORG, EVENT, PAYLOAD,
    );

    expect(mockPostSafeWebhook).toHaveBeenCalledTimes(1);
    const log = insertedLogs[0];
    expect(log?.["success"]).toBe(false);
  });

  it("I3 — dispatch logs errors rather than swallowing them silently", async () => {
    const failingDb = {
      query: {
        webhookEndpoints: {
          findMany: jest.fn().mockRejectedValue(new Error("DB down")),
          findFirst: jest.fn().mockResolvedValue(undefined),
        },
        webhookLogs: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    } as unknown as Db;

    const failingSvc = new WebhooksDispatchService(failingDb);
    failingSvc.dispatch(ORG, EVENT, PAYLOAD);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("dispatch run failed"),
      expect.objectContaining({ orgId: ORG, eventName: EVENT }),
    );
  });
});

describe("classifyWebhookError — unit", () => {
  it("returns terminal for WebhookTerminalStatusError (4xx)", () => {
    expect(classifyWebhookError(new WebhookTerminalStatusError(422, "body"))).toBe("terminal");
    expect(classifyWebhookError(new WebhookTerminalStatusError(404, "not found"))).toBe("terminal");
  });

  it("returns terminal for UnsafeWebhookTargetError (SSRF block)", () => {
    expect(classifyWebhookError(new UnsafeWebhookTargetError("blocked-address"))).toBe("terminal");
    expect(classifyWebhookError(new UnsafeWebhookTargetError("private-ip"))).toBe("terminal");
  });

  it("returns retryable for generic Error (network, timeout)", () => {
    expect(classifyWebhookError(new Error("ECONNRESET"))).toBe("retryable");
    expect(classifyWebhookError(new Error("AbortError"))).toBe("retryable");
  });

  it("returns retryable for non-Error throws", () => {
    expect(classifyWebhookError("string error")).toBe("retryable");
    expect(classifyWebhookError(null)).toBe("retryable");
  });
});
