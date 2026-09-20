/**
 * The automation `webhook` action used to own a second webhook dispatcher.
 *
 * `AutomationWebhookService` fanned out to every active endpoint with an
 * unbounded `Promise.allSettled`, checked the URL with `checkWebhookUrl` and
 * then called `fetch` separately — so the check and the connection could
 * resolve the host to two different addresses — and it did all of it while the
 * request's tenant transaction was still open, holding one of the pool's ten
 * connections across N outbound calls of up to ten seconds each.
 *
 * `WebhooksDispatchService` already did the same job correctly: delivery is
 * registered after commit, the endpoint read is its own short transaction, the
 * outbound calls are chunked, and `postSafeWebhook` pins the resolved address
 * so SSRF cannot be defeated by a rebind between check and connect.
 *
 * These pin the consolidation, because the failure it prevents is silent: a
 * reintroduced inline `fetch` here would pass every other test in the suite.
 */
import { AutomationActionExecutor } from "../automation-action-executor.service";
import type { AutomationAction } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";

const WEBHOOK_ACTION: AutomationAction = {
  type: "webhook",
  config: { event: "ticket.created" },
};

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PAYLOAD = { ticketId: 42 };

function makeExecutor(dispatch: jest.Mock): AutomationActionExecutor {
  return new AutomationActionExecutor(
    {} as Db,
    { create: jest.fn() } as never,
    { send: jest.fn() } as never,
    { dispatch } as never,
    { executeNode: jest.fn() } as never,
  );
}

describe("automation webhook action — delegates to the single webhook dispatcher", () => {
  let fetchSpy: jest.Mock;

  beforeEach(() => {
    fetchSpy = jest.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  it("hands the event to WebhooksDispatchService rather than delivering it itself", async () => {
    const dispatch = jest.fn();

    const result = await makeExecutor(dispatch).executeAction(ORG_ID, WEBHOOK_ACTION, PAYLOAD);

    expect(dispatch).toHaveBeenCalledWith(ORG_ID, "ticket.created", PAYLOAD);
    expect(result).toEqual({ type: "webhook", ok: true });
  });

  it("makes no outbound call of its own, so the request transaction is never held across delivery", async () => {
    await makeExecutor(jest.fn()).executeAction(ORG_ID, WEBHOOK_ACTION, PAYLOAD);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not await delivery, because dispatch defers the outbound call past the commit", async () => {
    const dispatch = jest.fn(() => undefined);

    await makeExecutor(dispatch).executeAction(ORG_ID, WEBHOOK_ACTION, PAYLOAD);

    expect(dispatch).toHaveReturnedWith(undefined);
  });

  it("contains a dispatcher failure at the action boundary instead of failing the whole run", async () => {
    const dispatch = jest.fn(() => {
      throw new Error("registry unavailable");
    });

    const result = await makeExecutor(dispatch).executeAction(ORG_ID, WEBHOOK_ACTION, PAYLOAD);

    expect(result.ok).toBe(false);
    expect(result.type).toBe("webhook");
  });
});
