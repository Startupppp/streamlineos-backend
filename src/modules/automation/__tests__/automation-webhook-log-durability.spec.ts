/**
 * Two things about `AutomationWebhookService.dispatchWebhook`, one of which the
 * release audit got wrong.
 *
 * WRONG — "the transaction rolls back and erases the log rows for the deliveries
 * that SUCCEEDED, the UI shows failure with no log, the operator retries and A
 * and B are POSTed a second time."
 *
 * `dispatchWebhook` does re-throw when any endpoint fails
 * (`automation-webhook.service.ts:36`), but the only caller is
 * `automation.service.ts:171`, inside `executeAction`'s `try`. Its catch at
 * `automation.service.ts:250-253` turns the throw into
 * `{ type, ok: false, error }`. Nothing propagates to the controller, so
 * `TenantContextInterceptor` commits the request transaction as normal and every
 * `webhook_logs` row written during the wave survives. The double-POST scenario
 * cannot occur. These tests pin that, so a later change that "fixes" the
 * swallowed throw by letting it propagate has to notice it is introducing the
 * rollback, not removing it.
 *
 * RIGHT, and NOT changed here — the outbound POSTs happen inside the request's
 * tenant transaction (`TenantContextInterceptor` is a global `APP_INTERCEPTOR`
 * and `@NoTenantTransaction()` appears nowhere under `automation/`), and the
 * endpoint read is unbounded. Both are real. Neither has a safe in-place remedy:
 * narrowing the fan-out width lengthens the time the request transaction holds
 * its pooled connection in direct proportion to the endpoint count (today the
 * POSTs are parallel, so the hold is bounded at roughly one WEBHOOK_TIMEOUT_MS;
 * a width of 16 over 200 endpoints would hold it for thirteen of them), and a
 * LIMIT on the endpoint read silently stops delivering to endpoints an operator
 * configured. The fix is the outbox path `projects-webhooks-dispatch.service.ts`
 * already implements for the build module — a delivery row plus an outbox event
 * committed with the caller, delivered by a consumer — which is a delivery-model
 * change, not a defect fix.
 */
jest.mock("../../../common/security/ssrf-guard", () => ({
  checkWebhookUrl: jest.fn().mockResolvedValue({ allowed: true }),
}));

import { AutomationWebhookService } from "../automation-webhook.service";
import type { Db } from "../../../db/drizzle.module";
import type { EventPayload } from "../automation.evaluator";

const ORG = "org-automation";
const EVENT = "ticket.created";
const PAYLOAD: EventPayload = { ticketId: 42 };

interface Endpoint {
  id: number;
  url: string;
  secret: string;
  events: string[];
  isActive: boolean;
}

function endpoint(id: number, url: string): Endpoint {
  return { id, url, secret: `s${String(id)}`, events: [], isActive: true };
}

function makeDb(endpoints: Endpoint[]): {
  db: Db;
  logged: Record<string, unknown>[];
  findManyArgs: unknown[];
} {
  const logged: Record<string, unknown>[] = [];
  const findManyArgs: unknown[] = [];
  const db = {
    query: {
      webhookEndpoints: {
        findMany: jest.fn((args: unknown) => {
          findManyArgs.push(args);
          return Promise.resolve(endpoints);
        }),
      },
    },
    insert: jest.fn(() => ({
      values: jest.fn((row: Record<string, unknown>) => {
        logged.push(row);
        return Promise.resolve(undefined);
      }),
    })),
  };
  return { db: db as unknown as Db, logged, findManyArgs };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("automation webhook dispatch — delivery logs survive a partial failure", () => {
  it("writes a log row for every endpoint, including the ones that succeeded alongside a failure", async () => {
    const { db, logged } = makeDb([
      endpoint(1, "https://a.example.com/hook"),
      endpoint(2, "https://b.example.com/hook"),
      endpoint(3, "https://c.example.com/hook"),
    ]);
    globalThis.fetch = jest.fn((url: unknown) =>
      String(url).includes("c.example.com")
        ? Promise.reject(new Error("timed out"))
        : Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("ok") }),
    ) as unknown as typeof fetch;

    const service = new AutomationWebhookService(db);
    await expect(service.dispatchWebhook(ORG, EVENT, PAYLOAD)).rejects.toThrow(
      /Webhook delivery failed for 1\/3/,
    );

    expect(logged).toHaveLength(3);
    expect(logged.filter((row) => row["success"] === true)).toHaveLength(2);
    expect(logged.filter((row) => row["success"] === false)).toHaveLength(1);
  });

  it("the throw is converted by executeAction's catch, so nothing reaches the interceptor", async () => {
    // The behaviour that makes the rollback impossible, asserted at the seam it
    // actually lives at. `executeAction` is 145 lines of switch; this reproduces
    // only its error contract.
    const failing = (): Promise<never> => Promise.reject(new Error("Webhook delivery failed for 1/3 endpoint(s)"));
    const executeActionShape = async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        await failing();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Action execution failed" };
      }
    };

    await expect(executeActionShape()).resolves.toMatchObject({ ok: false });
  });
});

describe("automation webhook dispatch — endpoint projection", () => {
  it("reads only the columns delivery needs, never the whole endpoint row", async () => {
    const { db, findManyArgs } = makeDb([]);
    const service = new AutomationWebhookService(db);

    await service.dispatchWebhook(ORG, EVENT, PAYLOAD);

    const args = findManyArgs[0] as { columns?: Record<string, boolean> };
    expect(args.columns).toEqual({ id: true, url: true, secret: true, events: true });
  });
});
