import { OutboxConsumerRegistry } from "../../../common/outbox/outbox-consumer.registry";
import type { OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";
import {
  PayrollPostingIntentConsumer,
  PAYROLL_RUN_POSTING_INTENT_EVENT,
} from "../payout/payroll-posting-intent.consumer";
import { LockingService } from "../payout/locking.service";
import type { Db } from "../../../db/drizzle.module";

const ORG_ID = "org-payroll-test";
const RUN_ID = 42;
const MONTH = "2026-08";
const GROSS = "500000";
const DEDUCTIONS = "50000";
const NET = "400000";
const EMPLOYER_COST = "20000";
const ACTOR_USER_ID = "u-actor";

function makeOutboxEvent(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: "event-posting-intent-1",
    organizationId: ORG_ID,
    aggregateType: "payroll_run",
    aggregateId: String(RUN_ID),
    aggregateVersion: 1,
    schemaVersion: 1,
    causationId: null,
    correlationId: null,
    actorMembershipId: null,
    audience: "INTERNAL",
    lifecycleState: "ACTIVE",
    deliveryState: "IN_FLIGHT",
    eventType: PAYROLL_RUN_POSTING_INTENT_EVENT,
    payload: {
      runId: RUN_ID,
      month: MONTH,
      gross: GROSS,
      deductions: DEDUCTIONS,
      net: NET,
      employerCost: EMPLOYER_COST,
      actorUserId: ACTOR_USER_ID,
      orgId: ORG_ID,
    },
    occurredAt: new Date(),
    publishedAt: null,
    leaseExpiresAt: new Date(Date.now() + 30_000),
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeConsumerDb(claimResult: { id: number }[] = [{ id: 1 }]) {
  const setMock = jest.fn().mockReturnValue({
    where: jest.fn().mockResolvedValue([]),
  });
  const update = jest.fn().mockReturnValue({ set: setMock });
  const insert = jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      onConflictDoNothing: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(claimResult),
      }),
    }),
  });
  const execute = jest.fn().mockResolvedValue([]);
  const select = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    }),
  });
  return { execute, update, insert, select, _setMock: setMock };
}

function makeLockingDb(run: object, txBehavior: (tx: object) => Promise<void> = () => Promise.resolve()) {
  let outerSelectIdx = 0;

  const txValuesMock = jest.fn().mockReturnValue({
    onConflictDoUpdate: jest.fn().mockResolvedValue([]),
    returning: jest.fn().mockResolvedValue([]),
  });
  const txInsert = jest.fn().mockReturnValue({ values: txValuesMock });

  const txUpdate = jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  });
  const txSelect = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    }),
  });
  const tx = {
    query: { payrollRunEmployees: { findFirst: jest.fn().mockResolvedValue(null) } },
    update: txUpdate,
    insert: txInsert,
    select: txSelect,
  };
  const txFn = jest.fn().mockImplementation(async (fn: (t: typeof tx) => Promise<void>) => {
    await fn(tx);
    await txBehavior(tx);
  });
  const db = {
    query: { payrollRuns: { findFirst: jest.fn().mockResolvedValue(run) } },
    transaction: txFn,
    select: jest.fn().mockImplementation(() => {
      const idx = outerSelectIdx++;
      const memberData =
        idx === 0
          ? [{ id: 99, orgId: ORG_ID, userId: ACTOR_USER_ID, role: "MEMBER", isOwner: false, status: "ACTIVE" }]
          : [];
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(memberData) }),
        }),
      };
    }),
  };
  return { db: db as unknown as Db, tx, txInsert, txValuesMock };
}

function baseRun() {
  return {
    id: RUN_ID,
    orgId: ORG_ID,
    status: "APPROVED",
    month: MONTH,
    grossTotal: GROSS,
    deductionTotal: DEDUCTIONS,
    netTotal: NET,
    employerCostTotal: EMPLOYER_COST,
  };
}

describe("AR-07 — rollback cannot leave an accounting journal", () => {
  const audit = { log: jest.fn() } as never;
  const generate = { postPayrollLock: jest.fn().mockResolvedValue(undefined) } as never;

  it("if the lock transaction is rolled back, lock() rejects — the outbox emit was inside the tx and would be rolled back atomically", async () => {
    const ROLLBACK = new Error("simulated-payroll-rollback");
    const { db, txValuesMock } = makeLockingDb(baseRun(), async () => { throw ROLLBACK; });
    const svc = new LockingService(db, audit, generate);

    await expect(svc.lock(ORG_ID, ACTOR_USER_ID, RUN_ID)).rejects.toThrow("simulated-payroll-rollback");

    // The outbox emit ran INSIDE fn(tx) before the error — a real DB rollback undoes it atomically.
    const allValuesCalls = txValuesMock.mock.calls;
    const postingIntentEmit = allValuesCalls.find((args: unknown[]) => {
      const row = args[0] as { eventType?: string } | undefined;
      return row?.eventType === PAYROLL_RUN_POSTING_INTENT_EVENT;
    });
    expect(postingIntentEmit).toBeDefined();
  });

  it("lock transaction success emits exactly one posting-intent event inside the tx", async () => {
    const { db, txValuesMock } = makeLockingDb(baseRun());
    const svc = new LockingService(db, audit, generate);

    await svc.lock(ORG_ID, ACTOR_USER_ID, RUN_ID);

    // txValuesMock is shared across all tx.insert(...).values(...) calls.
    // Find exactly one call that carried the posting-intent event type.
    const postingIntentRows = txValuesMock.mock.calls.filter((args: unknown[]) => {
      const row = args[0] as { eventType?: string } | undefined;
      return row?.eventType === PAYROLL_RUN_POSTING_INTENT_EVENT;
    });
    expect(postingIntentRows).toHaveLength(1);
  });
});

describe("AR-07 — crash-between-commit-and-consume: intent survives and replays", () => {
  it("a PENDING outbox event is consumed and posts the journal exactly once", async () => {
    const consumerDb = makeConsumerDb();
    const postFinalized = jest.fn().mockResolvedValue(undefined);
    const payrollPosting = { postFinalized } as never;
    const registry = new OutboxConsumerRegistry();
    const consumer = new PayrollPostingIntentConsumer(consumerDb as never, payrollPosting, registry);
    consumer.onModuleInit();

    await consumer.handle(makeOutboxEvent());

    expect(postFinalized).toHaveBeenCalledTimes(1);
    expect(postFinalized).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID }),
      RUN_ID,
      MONTH,
      GROSS,
      DEDUCTIONS,
      NET,
      EMPLOYER_COST,
    );

    // Verify postingState was set to "posted" via the shared set mock.
    const allSetArgs = consumerDb._setMock.mock.calls as Array<[Record<string, unknown>]>;
    const stateSetCall = allSetArgs.find((args) => args[0]?.postingState === "posted");
    expect(stateSetCall).toBeDefined();
  });
});

describe("AR-07 — replay/duplicate-delivery cannot duplicate a journal", () => {
  it("second delivery with same eventId is skipped — inbox claim prevents duplicate posting", async () => {
    const postFinalized = jest.fn().mockResolvedValue(undefined);
    const payrollPosting = { postFinalized } as never;
    const registry = new OutboxConsumerRegistry();

    const dbFirst = makeConsumerDb([{ id: 1 }]);
    const consumerFirst = new PayrollPostingIntentConsumer(dbFirst as never, payrollPosting, registry);
    consumerFirst.onModuleInit();
    await consumerFirst.handle(makeOutboxEvent());
    expect(postFinalized).toHaveBeenCalledTimes(1);

    // Second delivery: inbox claim returns empty (conflict on unique key) → skipped.
    const dbSecond = makeConsumerDb([]);
    const consumerSecond = new PayrollPostingIntentConsumer(dbSecond as never, payrollPosting, registry);
    await consumerSecond.handle(makeOutboxEvent());

    expect(postFinalized).toHaveBeenCalledTimes(1);
  });

  it("consumer is registered with the correct event type", () => {
    const db = makeConsumerDb();
    const payrollPosting = { postFinalized: jest.fn() } as never;
    const registry = new OutboxConsumerRegistry();
    const consumer = new PayrollPostingIntentConsumer(db as never, payrollPosting, registry);

    consumer.onModuleInit();

    expect(registry.get(PAYROLL_RUN_POSTING_INTENT_EVENT)).toBe(consumer);
  });

  it("malformed payload is rejected without calling postFinalized", async () => {
    const db = makeConsumerDb();
    const postFinalized = jest.fn();
    const payrollPosting = { postFinalized } as never;
    const registry = new OutboxConsumerRegistry();
    const consumer = new PayrollPostingIntentConsumer(db as never, payrollPosting, registry);
    consumer.onModuleInit();

    await consumer.handle(makeOutboxEvent({ payload: { bad: "data" } }));

    expect(postFinalized).not.toHaveBeenCalled();
  });

  it("cross-tenant orgId mismatch is rejected without calling postFinalized", async () => {
    const db = makeConsumerDb();
    const postFinalized = jest.fn();
    const payrollPosting = { postFinalized } as never;
    const registry = new OutboxConsumerRegistry();
    const consumer = new PayrollPostingIntentConsumer(db as never, payrollPosting, registry);
    consumer.onModuleInit();

    const crossTenantPayload = {
      runId: RUN_ID,
      month: MONTH,
      gross: GROSS,
      deductions: DEDUCTIONS,
      net: NET,
      employerCost: EMPLOYER_COST,
      actorUserId: ACTOR_USER_ID,
      orgId: "org-different-tenant",
    };

    await consumer.handle(makeOutboxEvent({ payload: crossTenantPayload }));

    expect(postFinalized).not.toHaveBeenCalled();
  });

  it("postFinalized failure re-throws so the outbox publisher can retry", async () => {
    const db = makeConsumerDb();
    const postFinalized = jest.fn().mockRejectedValue(new Error("accounting-period-closed"));
    const payrollPosting = { postFinalized } as never;
    const registry = new OutboxConsumerRegistry();
    const consumer = new PayrollPostingIntentConsumer(db as never, payrollPosting, registry);
    consumer.onModuleInit();

    await expect(consumer.handle(makeOutboxEvent())).rejects.toThrow("accounting-period-closed");
  });
});
