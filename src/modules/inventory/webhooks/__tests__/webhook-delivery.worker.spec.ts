import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import type { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import type { WebhookTransportService } from "../webhook-transport.service";
import { InventoryWebhookDeliveryWorker } from "../webhook-delivery.worker";
import {
  WEBHOOK_DISABLE_AFTER_DEAD_LETTERS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_SCHEDULE_MS,
} from "../webhook-delivery-policy";

const mockForEachOrg = jest.fn();
const mockRunInNewTenantTransaction = jest.fn();

jest.mock("../../../../common/tenant", () => ({
  forEachOrg: (...args: unknown[]) => mockForEachOrg(...args),
}));

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (...args: unknown[]) => mockRunInNewTenantTransaction(...args),
}));

const ORG = "org-1";
const WEBHOOK_ID = 7;

interface Recorded {
  /** Every `.set({...})` payload, in the order the worker issued it. */
  sets: Record<string, unknown>[];
  /** Coarse trace of externally visible effects, for order assertions. */
  trace: string[];
}

/**
 * One chainable, thenable node. Drizzle's builders are awaited directly in some
 * places and terminated with `.returning()` in others, so the node has to be
 * both — and it resolves by *what was asked for* rather than by call order,
 * because which statements a tick issues depends on the scenario.
 */
function node(
  resolve: (state: { set?: Record<string, unknown>; limited: boolean }) => unknown[],
  recorded: Recorded,
) {
  const state: { set?: Record<string, unknown>; limited: boolean } = { limited: false };
  const self: Record<string, unknown> = {
    set: (values: Record<string, unknown>) => {
      state.set = values;
      recorded.sets.push(values);
      if (values.isActive === false) recorded.trace.push("disable-webhook");
      if (values.alertedAt instanceof Date) recorded.trace.push("stamp-alerted-at");
      return self;
    },
    from: () => self,
    where: () => self,
    limit: () => {
      state.limited = true;
      return self;
    },
    orderBy: () => self,
    values: () => self,
    onConflictDoNothing: () => self,
    returning: () => Promise.resolve(resolve(state)),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(resolve(state)).then(res, rej),
  };
  return self;
}

function makeTx(
  fixtures: { claimedEvent: Record<string, unknown>; webhookRow: Record<string, unknown>; health: Record<string, unknown> },
  recorded: Recorded,
) {
  const resolveUpdate = (state: { set?: Record<string, unknown> }): unknown[] => {
    const values = state.set ?? {};
    if (values.lastError === "webhook-deleted") return []; // orphan sweep: none
    if (values.leaseExpiresAt instanceof Date && values.status === undefined) {
      return [fixtures.claimedEvent]; // the claim
    }
    if (values.status !== undefined && values.attempts !== undefined) {
      return [{ id: fixtures.claimedEvent.id }]; // event outcome, fence passes
    }
    if (values.isActive === false) return [{ id: fixtures.webhookRow.id }]; // auto-disable applied
    return [];
  };

  const resolveSelect = (state: { limited: boolean }): unknown[] =>
    state.limited ? [fixtures.health] : [fixtures.webhookRow];

  return {
    update: () => node(resolveUpdate, recorded),
    select: () => node(resolveSelect, recorded),
    insert: () => node(() => [], recorded),
    delete: () => node(() => [], recorded),
  };
}

interface Scenario {
  attempts: number;
  isActive?: boolean;
  consecutiveFailures: number;
  alertedAt: Date | null;
  deliverOk?: boolean;
  members?: { userId: string }[];
}

function wire(scenario: Scenario) {
  const recorded: Recorded = { sets: [], trace: [] };

  const claimedEvent = {
    id: 4213,
    webhookId: WEBHOOK_ID,
    eventType: "inventory.stock.changed",
    payload: { sku: "X-1" },
    attempts: scenario.attempts,
    createdAt: new Date("2026-08-28T00:00:00.000Z"),
  };
  const webhookRow = {
    id: WEBHOOK_ID,
    url: "https://hooks.example.com/inv",
    secret: "s".repeat(64),
    isActive: scenario.isActive ?? true,
  };

  const tx = makeTx(
    {
      claimedEvent,
      webhookRow,
      health: {
        // Post-increment health, as the DB would report it.
        consecutiveFailures: scenario.consecutiveFailures,
        alertedAt: scenario.alertedAt,
        isActive: scenario.isActive ?? true,
        url: webhookRow.url,
      },
    },
    recorded,
  );

  mockForEachOrg.mockImplementation(
    async (_db: unknown, _sweep: string, fn: (tx: unknown, orgId: string) => Promise<void>) => {
      await fn(tx, ORG);
      return { organizations: 1, succeeded: 1, failed: 0 };
    },
  );
  mockRunInNewTenantTransaction.mockImplementation(
    async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  );

  const deliver = jest.fn().mockResolvedValue(
    scenario.deliverOk
      ? { ok: true, httpStatus: 200 }
      : { ok: false, httpStatus: 503, error: "http:503" },
  );
  const transport = { deliver } as unknown as WebhookTransportService;

  const emit = jest.fn().mockImplementation(async () => {
    recorded.trace.push("alert-notification");
    return { deferred: false };
  });
  const dispatch = { emit } as unknown as NotificationDispatchService;

  const membersWithPermission = jest
    .fn()
    .mockResolvedValue(scenario.members ?? [{ userId: "user-1" }]);
  const access = { membersWithPermission } as unknown as AccessService;

  const insert = jest.fn().mockImplementation(async (_tx: unknown, input: { action: string }) => {
    recorded.trace.push(`audit:${input.action}`);
  });
  const audit = { insert } as unknown as InventoryAuditService;

  const worker = new InventoryWebhookDeliveryWorker(
    {} as Db,
    transport,
    dispatch,
    access,
    audit,
  );

  return { worker, recorded, deliver, emit, membersWithPermission, insert };
}

/**
 * E7 — the properties the work order names, on the real worker.
 *
 * Everything below was previously unrepresentable: `InventoryWebhookEmitter`
 * delivered inline, once, and swallowed the result, so there was no second
 * attempt to schedule, nothing to dead-letter, and no notion of an endpoint's
 * health to alert on.
 */
describe("InventoryWebhookDeliveryWorker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockForEachOrg.mockReset();
    mockRunInNewTenantTransaction.mockReset();
  });

  it("reschedules a failing endpoint on the first retry delay instead of losing the event", async () => {
    const before = Date.now();
    const { worker, recorded, deliver } = wire({
      attempts: 0,
      consecutiveFailures: 0,
      alertedAt: null,
    });

    const result = await worker.run();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ claimed: 1, retried: 1, dead: 0, delivered: 0 });

    const outcome = recorded.sets.find((s) => s.status === "PENDING" && s.attempts === 1);
    expect(outcome).toBeDefined();
    expect(outcome!.deadLetteredAt).toBeNull();
    expect(outcome!.lastError).toBe("http:503");

    const delay = (outcome!.nextAttemptAt as Date).getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(WEBHOOK_RETRY_SCHEDULE_MS[0]!);
    expect(delay).toBeLessThan(WEBHOOK_RETRY_SCHEDULE_MS[0]! + 5_000);

    // Nothing escalates on a first failure: the endpoint has had one bad second.
    expect(recorded.trace).toEqual([]);
  });

  it("dead-letters once the retry schedule is exhausted, and alerts without disabling", async () => {
    const { worker, recorded, emit, membersWithPermission } = wire({
      attempts: WEBHOOK_MAX_ATTEMPTS - 1,
      consecutiveFailures: 1,
      alertedAt: null,
    });

    const result = await worker.run();

    expect(result).toMatchObject({ claimed: 1, dead: 1, retried: 0, alerted: 1, disabled: 0 });

    const outcome = recorded.sets.find((s) => s.status === "FAILED" && s.attempts !== undefined);
    expect(outcome).toBeDefined();
    expect(outcome!.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(outcome!.nextAttemptAt).toBeNull();
    expect(outcome!.deadLetteredAt).toBeInstanceOf(Date);

    // The alert reaches the people who can fix it, not org admins by position.
    expect(membersWithPermission).toHaveBeenCalledWith(ORG, "inventory:webhooks:manage");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toMatchObject({
      orgId: ORG,
      eventKey: "inventory.webhook.failing",
      targetUserIds: ["user-1"],
      entityId: String(WEBHOOK_ID),
    });

    expect(recorded.trace).toContain("audit:webhook.delivery.alerted");
    expect(recorded.trace).not.toContain("disable-webhook");
    expect(recorded.trace).not.toContain("audit:webhook.auto_disabled");
  });

  it("fires the alert before it disables the webhook", async () => {
    // The disable threshold reached on this dead letter, with the streak's alert
    // already stamped on an earlier one — the ordinary path to an auto-disable.
    const { worker, recorded } = wire({
      attempts: WEBHOOK_MAX_ATTEMPTS - 1,
      consecutiveFailures: WEBHOOK_DISABLE_AFTER_DEAD_LETTERS,
      alertedAt: new Date("2026-08-27T00:00:00.000Z"),
    });

    const result = await worker.run();

    expect(result).toMatchObject({ dead: 1, disabled: 1 });
    expect(recorded.trace).toContain("disable-webhook");
    expect(recorded.trace).toContain("audit:webhook.auto_disabled");

    const disabled = recorded.sets.find((s) => s.isActive === false);
    expect(disabled).toBeDefined();
    expect(disabled!.disabledAt).toBeInstanceOf(Date);
    expect(String(disabled!.disabledReason)).toContain("undeliverable");
  });

  it("alerts before disabling within a single pass when both thresholds trip at once", async () => {
    // Belt to the braces of the thresholds themselves: even if a later change
    // made the alert and the disable reachable on the same dead letter, the
    // notification must still land first.
    const { worker, recorded } = wire({
      attempts: WEBHOOK_MAX_ATTEMPTS - 1,
      consecutiveFailures: WEBHOOK_DISABLE_AFTER_DEAD_LETTERS,
      alertedAt: null,
    });

    await worker.run();

    const alert = recorded.trace.indexOf("alert-notification");
    const disable = recorded.trace.indexOf("disable-webhook");
    expect(alert).toBeGreaterThanOrEqual(0);
    expect(disable).toBeGreaterThanOrEqual(0);
    expect(alert).toBeLessThan(disable);
  });

  it("still records the alert when nobody in the org holds the permission", async () => {
    const { worker, recorded, emit } = wire({
      attempts: WEBHOOK_MAX_ATTEMPTS - 1,
      consecutiveFailures: 1,
      alertedAt: null,
      members: [],
    });

    const result = await worker.run();

    expect(emit).not.toHaveBeenCalled();
    expect(result.alerted).toBe(1);
    expect(recorded.trace).toContain("audit:webhook.delivery.alerted");
  });

  it("clears the failure streak on a successful delivery", async () => {
    const { worker, recorded, emit } = wire({
      attempts: 3,
      consecutiveFailures: 2,
      alertedAt: new Date(),
      deliverOk: true,
    });

    const result = await worker.run();

    expect(result).toMatchObject({ delivered: 1, dead: 0, retried: 0 });
    const health = recorded.sets.find((s) => s.lastDeliveryStatus === "DELIVERED");
    expect(health).toMatchObject({ consecutiveFailures: 0, failingSince: null, alertedAt: null });
    expect(emit).not.toHaveBeenCalled();
  });

  it("terminates an event whose webhook was switched off rather than retrying into it", async () => {
    const { worker, recorded, deliver } = wire({
      attempts: 0,
      isActive: false,
      consecutiveFailures: 0,
      alertedAt: null,
    });

    const result = await worker.run();

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dead: 1 });
    expect(recorded.sets.find((s) => s.lastError === "webhook-inactive")).toBeDefined();
  });
});
