/**
 * Verifies that the webhook dispatcher uses callProvider for retry + circuit breaker.
 *
 * Bite proof strategy: mock callProvider at the module level so tests can choose between
 * the real implementation (which honours classify) and a neutered one (which ignores it).
 * The contrast proves the classify gate is load-bearing.
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

jest.mock("../../common/security/ssrf-guard", () => ({
  checkWebhookUrl: jest.fn().mockResolvedValue({ allowed: true }),
}));

jest.mock("../../common/security/secret-encryption.util", () => ({
  isEncryptedSecret: jest.fn().mockReturnValue(false),
  decryptSecret: jest.fn((s: string) => s),
}));

/*
  `deliverNow` reads the endpoints in the org's own new transaction and writes
  each log row in a short one of its own. The db double is a bare query surface,
  so both helpers hand it to the callback as the transaction.
*/
jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T>(db: unknown, fn: (tx: unknown) => Promise<T>) => fn(db),
  runInNewTenantTransaction: <T>(db: unknown, _orgId: string, fn: (tx: unknown) => Promise<T>) =>
    fn(db),
}));

import { callProvider } from "../../common/outbound/call-provider";
import type { ProviderDescriptor, ProviderCallResult } from "../../common/outbound/call-provider";
import type { Db } from "../../db/drizzle.module";
import {
  WebhooksDispatchService,
  WebhookTerminalStatusError,
  classifyWebhookError,
} from "./webhooks-dispatch.service";

const mockFetch = jest.fn();
global.fetch = mockFetch;

global.AbortSignal = {
  ...global.AbortSignal,
  timeout: jest.fn().mockReturnValue({}),
} as unknown as typeof AbortSignal;

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

const callProviderSpy = callProvider as jest.Mock;

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

  it("classifies 4xx as terminal — exactly 1 fetch attempt, log records attempt=1", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
    });

    await svc.deliverNow(ORG, EVENT, PAYLOAD);

    expect(mockFetch).toHaveBeenCalledTimes(1);
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

    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    });

    await svc.deliverNow(ORG, EVENT, PAYLOAD);

    expect(mockFetch).toHaveBeenCalledTimes(5);
    const log = insertedLogs[0];
    expect(log?.["success"]).toBe(false);
    expect(log?.["attempt"]).toBe(5);
    expect(String(log?.["responseBody"])).toContain("Dead after 5");
  });

  it("succeeds and writes success=true when endpoint returns 2xx", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => "OK",
    });

    await svc.deliverNow(ORG, EVENT, PAYLOAD);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const log = insertedLogs[0];
    expect(log?.["success"]).toBe(true);
    expect(log?.["statusCode"]).toBe(200);
    expect(log?.["attempt"]).toBe(1);
  });

  it("bites: neutering callProvider to ignore classify causes 4xx to be retried 5 times", async () => {
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

    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      return { ok: false, status: 400, text: async () => "Bad Request" };
    });

    await svc.deliverNow(ORG, EVENT, PAYLOAD);

    expect(callCount).toBe(5);
  });
});

describe("classifyWebhookError — unit", () => {
  it("returns terminal for WebhookTerminalStatusError (4xx)", () => {
    expect(classifyWebhookError(new WebhookTerminalStatusError(422, "body"))).toBe("terminal");
    expect(classifyWebhookError(new WebhookTerminalStatusError(404, "not found"))).toBe("terminal");
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
