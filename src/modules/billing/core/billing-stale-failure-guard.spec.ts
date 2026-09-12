/**
 * AB-07 item 3: A late payment.failed for an OLD purchase must NOT downgrade a NEWER
 * already-paid subscription period to PAST_DUE.
 */

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async <T>(db: unknown, fn: (tx: unknown) => Promise<T>) => fn(db),
  runInNewTenantTransaction: async <T>(db: unknown, _orgId: string, fn: (tx: unknown) => Promise<T>) => fn(db),
}));

import { BillingPaymentState } from "./billing-payment-state";

type UpdateSetCall = { status: string };

function buildStateDb(sub: {
  id: number;
  metadata: Record<string, unknown> | null;
  currentPeriodStart: Date | null;
} | null) {
  const updates: UpdateSetCall[] = [];
  const db: Record<string, unknown> = {};

  db.select = () => ({
    from: () => ({
      where: () => ({
        for: () => ({ limit: () => Promise.resolve(sub ? [sub] : []) }),
      }),
    }),
  });

  db.update = () => ({
    set: (vals: UpdateSetCall) => ({
      where: () => {
        updates.push(vals);
        return Promise.resolve([]);
      },
    }),
  });

  db.insert = () => ({
    values: () => ({ onConflictDoNothing: () => Promise.resolve([]) }),
  });

  db.transaction = jest.fn().mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(db));

  return { db: db as never, updates };
}

function makePlanLimits() {
  return { bust: jest.fn().mockResolvedValue(undefined) };
}

const ORG_ID = "org-stale-test";

describe("AB-07 stale-failure guard — transitionToPastDue", () => {
  it("transitions to PAST_DUE when failing purchase was created AFTER current period started", async () => {
    const currentPeriodStart = new Date("2026-09-01T00:00:00Z");
    const purchaseCreatedAt = new Date("2026-09-10T00:00:00Z");
    const { db, updates } = buildStateDb({ id: 1, metadata: {}, currentPeriodStart });
    const state = new BillingPaymentState(db, makePlanLimits() as never);

    await state.transitionToPastDue(ORG_ID, "pay_001", { purchaseCreatedAt });

    expect(updates.find((u) => u.status === "PAST_DUE")).toBeDefined();
  });

  it("transitions to PAST_DUE when failing purchase was created AT the exact period start (equal)", async () => {
    const ts = new Date("2026-09-01T00:00:00Z");
    const { db, updates } = buildStateDb({ id: 1, metadata: {}, currentPeriodStart: ts });
    const state = new BillingPaymentState(db, makePlanLimits() as never);

    await state.transitionToPastDue(ORG_ID, "pay_001", { purchaseCreatedAt: ts });

    expect(updates.find((u) => u.status === "PAST_DUE")).toBeDefined();
  });

  it("does NOT transition to PAST_DUE when failing purchase predates the current period start", async () => {
    const currentPeriodStart = new Date("2026-09-10T00:00:00Z");
    const purchaseCreatedAt = new Date("2026-09-01T00:00:00Z");
    const { db, updates } = buildStateDb({ id: 1, metadata: {}, currentPeriodStart });
    const state = new BillingPaymentState(db, makePlanLimits() as never);

    await state.transitionToPastDue(ORG_ID, "pay_old_001", { purchaseCreatedAt });

    expect(updates.find((u) => u.status === "PAST_DUE")).toBeUndefined();
  });

  it("transitions when no guard is supplied (backwards compatibility — no change in callers not passing guard)", async () => {
    const { db, updates } = buildStateDb({
      id: 1,
      metadata: {},
      currentPeriodStart: new Date("2026-09-01T00:00:00Z"),
    });
    const state = new BillingPaymentState(db, makePlanLimits() as never);

    await state.transitionToPastDue(ORG_ID, "pay_001");

    expect(updates.find((u) => u.status === "PAST_DUE")).toBeDefined();
  });

  it("transitions when currentPeriodStart is null (guard cannot determine staleness)", async () => {
    const purchaseCreatedAt = new Date("2026-09-01T00:00:00Z");
    const { db, updates } = buildStateDb({ id: 1, metadata: {}, currentPeriodStart: null });
    const state = new BillingPaymentState(db, makePlanLimits() as never);

    await state.transitionToPastDue(ORG_ID, "pay_001", { purchaseCreatedAt });

    expect(updates.find((u) => u.status === "PAST_DUE")).toBeDefined();
  });
});
