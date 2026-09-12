import type { Logger } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import type { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import { WEBHOOK_DISABLE_AFTER_DEAD_LETTERS, planWebhookHealth } from "../webhook-delivery-policy";
import type { ClaimedDelivery } from "../lib/webhook-claim";
import { applyFailurePolicy, type WebhookHealthDeps } from "../lib/webhook-health";

/**
 * The auto-disable's compare-and-set, which nothing asserted.
 *
 * Found by mutation when the health policy moved out of
 * `webhook-delivery.worker.ts` into `lib/webhook-health.ts`. Four of the six
 * mutations on the moved code were caught by `webhook-delivery.worker.spec.ts`
 * (the alert and disable gating, the empty-audience branch, the audience's
 * permission key). Two were not, and they are the same guard: deleting the
 * `updated.length === 0` check, or deleting the `is_active = true` term from the
 * UPDATE's predicate, each left the whole inventory suite green (174 suites,
 * 1788 tests).
 *
 * The worker's own doc names the race this exists for — a slow tick overlapping
 * the next one — and an admin can switch a webhook off in the same window.
 * Without the compare-and-set the losing disable overwrites whatever
 * `disabledReason` is already on the row (an admin's included), writes a second
 * `webhook.auto_disabled` audit row, logs an auto-disable it did not perform,
 * and reports `disabled: true` into the sweep's count.
 */

const mockRunInNewTenantTransaction = jest.fn<Promise<unknown>, unknown[]>();

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (...args: unknown[]) => mockRunInNewTenantTransaction(...args),
}));

const ORG = "org-1";
const WEBHOOK_ID = 7;
const URL = "https://hooks.example.com/inv";

/** Past the disable threshold and already alerted, so the policy's only move is to disable. */
const ROW = {
  consecutiveFailures: WEBHOOK_DISABLE_AFTER_DEAD_LETTERS,
  alertedAt: new Date("2026-09-01T00:00:00.000Z"),
  isActive: true,
  url: URL,
};

const ITEM: ClaimedDelivery = {
  orgId: ORG,
  lease: new Date("2026-09-11T00:00:00.000Z"),
  event: {
    id: 4213,
    eventType: "inventory.stock.changed",
    payload: { sku: "X-1" },
    attempts: 11,
    createdAt: new Date("2026-09-10T00:00:00.000Z"),
  },
  webhook: { id: WEBHOOK_ID, url: URL, secret: "s".repeat(64), isActive: true },
};

interface SetCall {
  payload: Record<string, unknown>;
  where: SQL;
}

function harness(disableReturns: Array<{ id: number }>) {
  const sets: SetCall[] = [];
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [ROW] }) }) }),
    update: () => ({
      set: (payload: Record<string, unknown>) => ({
        // Awaited directly by the alert's stamp; `.returning()` by the disable.
        where: (where: SQL) => {
          sets.push({ payload, where });
          return Object.assign(Promise.resolve(), { returning: () => Promise.resolve(disableReturns) });
        },
      }),
    }),
  };
  mockRunInNewTenantTransaction
    .mockReset()
    .mockImplementation((...args: unknown[]) => (args[2] as (t: typeof tx) => Promise<unknown>)(tx));

  const auditInsert = jest.fn<Promise<void>, [unknown, { action: string }]>(async () => undefined);
  const error = jest.fn<void, [string]>();
  const warn = jest.fn<void, [string]>();
  const deps: WebhookHealthDeps = {
    db: {} as Db,
    access: { membersWithPermission: jest.fn(async () => []) } as unknown as AccessService,
    dispatch: { emit: jest.fn(async () => undefined) } as unknown as NotificationDispatchService,
    audit: { insert: auditInsert } as unknown as InventoryAuditService,
    logger: { error, warn } as unknown as Logger,
  };
  const auditActions = () => auditInsert.mock.calls.map(([, entry]) => entry.action);
  const disableSet = () => sets.find((s) => s.payload.isActive === false);
  return { deps, auditActions, disableSet, error };
}

describe("applyFailurePolicy — the auto-disable's compare-and-set", () => {
  it("uses a fixture the policy really does decide to disable (anti-vacuity)", () => {
    expect(planWebhookHealth(ROW).disable).toBe(true);
  });

  it("claims nothing when another writer switched the webhook off first", async () => {
    const h = harness([]);

    await expect(applyFailurePolicy(h.deps, ITEM, "http:503")).resolves.toMatchObject({ disabled: false });
    expect(h.auditActions()).not.toContain("webhook.auto_disabled");
    expect(h.error).not.toHaveBeenCalled();
  });

  it("only switches off a webhook that is still active", async () => {
    const h = harness([{ id: WEBHOOK_ID }]);

    await applyFailurePolicy(h.deps, ITEM, "http:503");
    const disable = h.disableSet();
    expect(disable).toBeDefined();
    const { sql, params } = new PgDialect().sqlToQuery(disable!.where);
    expect(sql).toMatch(/"is_active" = \$\d+/);
    expect(params).toEqual(expect.arrayContaining([ORG, WEBHOOK_ID, true]));
  });

  it("disables, audits once and logs once when it wins (control)", async () => {
    const h = harness([{ id: WEBHOOK_ID }]);

    await expect(applyFailurePolicy(h.deps, ITEM, "http:503")).resolves.toMatchObject({ disabled: true });
    expect(h.auditActions().filter((a) => a === "webhook.auto_disabled")).toHaveLength(1);
    expect(h.error).toHaveBeenCalledTimes(1);
  });
});
