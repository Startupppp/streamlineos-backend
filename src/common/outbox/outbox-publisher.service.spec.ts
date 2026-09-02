import { Logger } from "@nestjs/common";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { OutboxReportService } from "./outbox-report.service";
import { OutboxConsumerRegistry, type OutboxEventRow } from "./outbox-consumer.registry";
import type { TenantTx } from "../tenant";

const mockForEachOrg = jest.fn();
const mockRunInNewTenantTransaction = jest.fn();

jest.mock("../tenant", () => ({
  forEachOrg: (...args: unknown[]) => mockForEachOrg(...args),
}));

jest.mock("../tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (...args: unknown[]) => mockRunInNewTenantTransaction(...args),
}));

function makeTxMock() {
  const where = jest.fn().mockResolvedValue(undefined);
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  return { update, set, where };
}

function makeRow(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: "evt-1",
    organizationId: "org-1",
    aggregateType: "deal",
    aggregateId: "deal-1",
    aggregateVersion: 1,
    schemaVersion: 1,
    causationId: null,
    correlationId: null,
    actorMembershipId: null,
    audience: "INTERNAL",
    lifecycleState: "ACTIVE",
    deliveryState: "PENDING",
    eventType: "deal.closed",
    payload: {},
    occurredAt: new Date("2026-08-25T00:00:00.000Z"),
    publishedAt: null,
    leaseExpiresAt: null,
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date("2026-08-25T00:00:00.000Z"),
    ...overrides,
  };
}

function makeDb(orgStatus: string | null = "ACTIVE") {
  const limit = jest.fn().mockResolvedValue(
    orgStatus === null ? [] : [{ status: orgStatus }],
  );
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  return { select, where, limit, from };
}

function makeConfig(enabled: boolean) {
  return { OUTBOX_DISPATCH_ENABLED: enabled ? "true" : "false" };
}

function makeRegistry(eventType?: string) {
  const registry = new OutboxConsumerRegistry();
  if (eventType) {
    registry.register({
      eventType,
      handle: jest.fn().mockResolvedValue(undefined),
    });
  }
  return registry;
}

function makeService(
  db: ReturnType<typeof makeDb>,
  config: { OUTBOX_DISPATCH_ENABLED: string },
  registry: OutboxConsumerRegistry,
): OutboxPublisherService {
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  return new OutboxPublisherService(db as never, config as never, registry, new OutboxReportService(db as never));
}

function forEachOrgWithRow(row: OutboxEventRow) {
  return mockForEachOrg.mockImplementation(
    async (_db: unknown, _sweep: string, fn: (tx: TenantTx, orgId: string) => Promise<void>) => {
      const returning = jest.fn().mockResolvedValue([row]);
      const where = jest.fn().mockReturnValue({ returning });
      const set = jest.fn().mockReturnValue({ where });
      const update = jest.fn().mockReturnValue({ set });
      await fn({ update } as never, row.organizationId);
    },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRunInNewTenantTransaction.mockImplementation(
    async (db: ReturnType<typeof makeDb>, _orgId: string, fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) =>
      fn({ ...makeTxMock(), select: db.select } as ReturnType<typeof makeTxMock>),
  );
});

describe("OutboxPublisherService.flush — dispatch disabled", () => {
  it("returns all zeros and logs once when dispatch is not configured", async () => {
    const service = makeService(makeDb(), makeConfig(false), makeRegistry());

    const first = await service.flush();
    const second = await service.flush();

    expect(first).toEqual({ claimed: 0, delivered: 0, suppressed: 0, retried: 0, dead: 0, fenced: 0 });
    expect(second).toEqual({ claimed: 0, delivered: 0, suppressed: 0, retried: 0, dead: 0, fenced: 0 });
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
    expect(mockForEachOrg).not.toHaveBeenCalled();
  });
});

describe("OutboxPublisherService.flush — claimBatch uses forEachOrg", () => {
  it("calls forEachOrg to claim rows, not this.db directly", async () => {
    mockForEachOrg.mockResolvedValue({ organizations: 0, succeeded: 0, failed: 0 });
    const db = makeDb();
    const service = makeService(db, makeConfig(true), makeRegistry());

    await service.flush();

    expect(mockForEachOrg).toHaveBeenCalledWith(db, "outbox-events-flush", expect.any(Function));
  });

  it("accumulates claimed rows from multiple orgs", async () => {
    const row1 = makeRow({ outboxEventId: 1, organizationId: "org-1", eventType: "deal.closed" });
    const row2 = makeRow({ outboxEventId: 2, organizationId: "org-2", eventType: "deal.closed" });

    mockForEachOrg.mockImplementation(
      async (_db: unknown, _sweep: string, fn: (tx: TenantTx, orgId: string) => Promise<void>) => {
        const returning1 = jest.fn().mockResolvedValue([row1]);
        await fn({ update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: returning1 }) }) }) } as never, "org-1");
        const returning2 = jest.fn().mockResolvedValue([row2]);
        await fn({ update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: returning2 }) }) }) } as never, "org-2");
      },
    );

    const db1 = makeDb("ACTIVE");
    const db2 = makeDb("ACTIVE");
    const db = { select: jest.fn().mockReturnValueOnce({ from: db1.from }).mockReturnValueOnce({ from: db2.from }) };
    const service = makeService(db as never, makeConfig(true), makeRegistry("deal.closed"));

    const result = await service.flush();

    expect(result.claimed).toBe(2);
    expect(result.delivered).toBe(2);
  });
});

describe("OutboxPublisherService.flush — unconsumed event types", () => {
  it("retries an event whose type has no registered consumer", async () => {
    forEachOrgWithRow(makeRow({ eventType: "build.ticket.created", retryCount: 0 }));
    const db = makeDb("ACTIVE");
    const service = makeService(db, makeConfig(true), makeRegistry());

    const result = await service.flush();

    expect(result.suppressed).toBe(0);
    expect(result.delivered).toBe(0);
    expect(result.retried).toBe(1);
    expect(result.dead).toBe(0);
  });

  it("uses runInNewTenantTransaction to mark an unconsumed event PENDING, not this.db", async () => {
    const row = makeRow({ eventType: "build.ticket.created" });
    forEachOrgWithRow(row);
    const db = makeDb("ACTIVE");
    let capturedState: string | undefined;
    mockRunInNewTenantTransaction.mockImplementation(
      async (_db: unknown, _orgId: string, fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
        const tx = makeTxMock();
        tx.set = jest.fn().mockImplementation((patch: { deliveryState?: string }) => {
          if (patch.deliveryState) capturedState = patch.deliveryState;
          return { where: jest.fn().mockResolvedValue(undefined) };
        });
        tx.update = jest.fn().mockReturnValue(tx);
        (tx as typeof tx & { select: typeof db.select }).select = db.select;
        return fn(tx);
      },
    );
    const service = makeService(db, makeConfig(true), makeRegistry());

    await service.flush();

    expect(mockRunInNewTenantTransaction).toHaveBeenCalledWith(db, "org-1", expect.any(Function));
    expect(capturedState).toBe("PENDING");
  });

  it("dead-letters an unconsumed event after the retry ceiling", async () => {
    forEachOrgWithRow(makeRow({ eventType: "build.ticket.created", retryCount: 7 }));
    const db = makeDb("ACTIVE");
    const states: string[] = [];
    mockRunInNewTenantTransaction.mockImplementation(
      async (_db: unknown, _orgId: string, fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
        const tx = makeTxMock();
        tx.set = jest.fn().mockImplementation((patch: { deliveryState?: string }) => {
          if (patch.deliveryState) states.push(patch.deliveryState);
          return { where: jest.fn().mockResolvedValue(undefined) };
        });
        tx.update = jest.fn().mockReturnValue(tx);
        (tx as typeof tx & { select: typeof db.select }).select = db.select;
        return fn(tx);
      },
    );
    const service = makeService(db, makeConfig(true), makeRegistry());

    await service.flush();

    expect(states).not.toContain("DELIVERED");
    expect(states).toContain("DEAD");
  });
});

describe("OutboxPublisherService.flush — org lifecycle suppression", () => {
  it("suppresses an event when the org is archived", async () => {
    forEachOrgWithRow(makeRow({ eventType: "deal.closed" }));
    const service = makeService(makeDb("ARCHIVED"), makeConfig(true), makeRegistry("deal.closed"));

    const result = await service.flush();

    expect(result.suppressed).toBe(1);
    expect(result.delivered).toBe(0);
  });

  it("suppresses an event when the org row is not found", async () => {
    forEachOrgWithRow(makeRow({ eventType: "deal.closed" }));
    const service = makeService(makeDb(null), makeConfig(true), makeRegistry("deal.closed"));

    const result = await service.flush();

    expect(result.suppressed).toBe(1);
    expect(result.delivered).toBe(0);
  });
});

describe("OutboxPublisherService.flush — delivery and failure paths", () => {
  it("marks an event DELIVERED after successful consumer handle and uses runInNewTenantTransaction", async () => {
    forEachOrgWithRow(makeRow({ eventType: "deal.closed" }));
    const db = makeDb("ACTIVE");
    const states: string[] = [];
    mockRunInNewTenantTransaction.mockImplementation(
      async (_db: unknown, _orgId: string, fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
        const tx = makeTxMock();
        tx.set = jest.fn().mockImplementation((patch: { deliveryState?: string }) => {
          if (patch.deliveryState) states.push(patch.deliveryState);
          return { where: jest.fn().mockResolvedValue(undefined) };
      });
        tx.update = jest.fn().mockReturnValue(tx);
        (tx as typeof tx & { select: typeof db.select }).select = db.select;
        return fn(tx);
      },
    );
    const service = makeService(db, makeConfig(true), makeRegistry("deal.closed"));

    const result = await service.flush();

    expect(result.delivered).toBe(1);
    expect(states).toContain("DELIVERED");
    expect(mockRunInNewTenantTransaction).toHaveBeenCalledWith(db, "org-1", expect.any(Function));
  });

  it("retries a failing consumer and does not mark DELIVERED", async () => {
    forEachOrgWithRow(makeRow({ eventType: "deal.closed", retryCount: 0 }));
    const db = makeDb("ACTIVE");
    const states: string[] = [];
    mockRunInNewTenantTransaction.mockImplementation(
      async (_db: unknown, _orgId: string, fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
        const tx = makeTxMock();
        tx.set = jest.fn().mockImplementation((patch: { deliveryState?: string }) => {
          if (patch.deliveryState) states.push(patch.deliveryState);
          return { where: jest.fn().mockResolvedValue(undefined) };
      });
        tx.update = jest.fn().mockReturnValue(tx);
        (tx as typeof tx & { select: typeof db.select }).select = db.select;
        return fn(tx);
      },
    );
    const registry = new OutboxConsumerRegistry();
    registry.register({ eventType: "deal.closed", handle: jest.fn().mockRejectedValue(new Error("downstream down")) });
    const service = makeService(db, makeConfig(true), registry);

    const result = await service.flush();

    expect(result.retried).toBe(1);
    expect(result.delivered).toBe(0);
    expect(states).toContain("PENDING");
    expect(states).not.toContain("DELIVERED");
  });

  it("dead-letters after exhausting retries and does not mark DELIVERED", async () => {
    forEachOrgWithRow(makeRow({ eventType: "deal.closed", retryCount: 7 }));
    const db = makeDb("ACTIVE");
    const states: string[] = [];
    mockRunInNewTenantTransaction.mockImplementation(
      async (_db: unknown, _orgId: string, fn: (tx: ReturnType<typeof makeTxMock>) => Promise<unknown>) => {
        const tx = makeTxMock();
        tx.set = jest.fn().mockImplementation((patch: { deliveryState?: string }) => {
          if (patch.deliveryState) states.push(patch.deliveryState);
          return { where: jest.fn().mockResolvedValue(undefined) };
      });
        tx.update = jest.fn().mockReturnValue(tx);
        (tx as typeof tx & { select: typeof db.select }).select = db.select;
        return fn(tx);
      },
    );
    const registry = new OutboxConsumerRegistry();
    registry.register({ eventType: "deal.closed", handle: jest.fn().mockRejectedValue(new Error("still broken")) });
    const service = makeService(db, makeConfig(true), registry);

    const result = await service.flush();

    expect(result.dead).toBe(1);
    expect(result.delivered).toBe(0);
    expect(states).toContain("DEAD");
    expect(states).not.toContain("DELIVERED");
  });
});

describe("OutboxPublisherService.metrics", () => {
  it("aggregates tenant-scoped pending, in-flight, dead, and age metrics", async () => {
    const oldest = new Date("2026-08-24T00:00:00.000Z");
    mockForEachOrg.mockImplementation(
      async (_db: unknown, _sweep: string, fn: (tx: TenantTx, orgId: string) => Promise<void>) => {
        const makeTx = (row: Record<string, unknown>) => ({
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockResolvedValue([row]),
          }),
        });
        await fn(makeTx({ pending: "2", inFlight: "1", dead: "0", oldestPendingAt: oldest }) as never, "org-1");
        await fn(makeTx({ pending: "1", inFlight: "0", dead: "1", oldestPendingAt: null }) as never, "org-2");
      },
    );

    const db = makeDb();
    const service = makeService(db, makeConfig(true), makeRegistry());

    await expect(service.metrics()).resolves.toEqual({
      pending: 3,
      inFlight: 1,
      dead: 1,
      oldestPendingAt: oldest,
    });
    expect(mockForEachOrg).toHaveBeenCalledWith(db, "outbox-events-metrics", expect.any(Function));
  });

  it("reports every aggregate field and exposes tenant sweep failures", async () => {
    const oldest = new Date("2026-08-20T00:00:00.000Z");
    mockForEachOrg.mockImplementation(
      async (_db: unknown, _sweep: string, fn: (tx: TenantTx, orgId: string) => Promise<void>) => {
        await fn({
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockResolvedValue([{
              totalRows: "4", pending: "2", inFlight: "1", dead: "1",
              oldestPendingAt: oldest, oldestEventAt: oldest, distinctEventTypes: "3",
            }]),
          }),
        } as never, "org-1");
        return { organizations: 2, succeeded: 1, failed: 1 };
      },
    );

    const report = await makeService(makeDb(), makeConfig(true), makeRegistry()).report();

    expect(report).toMatchObject({ organizations: 2, succeeded: 1, failed: 1 });
    expect(report.reports).toHaveLength(1);
    expect(report.reports[0]).toMatchObject({
      organizationId: "org-1", totalRows: 4, pending: 2, inFlight: 1, dead: 1,
      oldestPendingAt: oldest, oldestEventAt: oldest, distinctEventTypes: 3,
    });
    expect(report.reports[0].oldestEventAgeSeconds).toEqual(expect.any(Number));
  });

  it("does not let a stale worker finalize a row reclaimed by a newer lease", async () => {
    const row = makeRow({
      eventType: "deal.closed",
      deliveryState: "IN_FLIGHT",
      leaseExpiresAt: new Date("2026-08-25T00:00:00.000Z"),
    });
    forEachOrgWithRow(row);
    const db = makeDb("ACTIVE");
    let transactionCalls = 0;
    mockRunInNewTenantTransaction.mockImplementation(
      async (_db: unknown, _orgId: string, fn: (tx: any) => Promise<unknown>) => {
        transactionCalls++;
        if (transactionCalls === 3) {
          const returning = jest.fn().mockResolvedValue([]);
          const where = jest.fn().mockReturnValue({ returning });
          const tx = { update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where }) }) };
          return fn(tx);
        }
        return fn({ ...makeTxMock(), select: db.select });
      },
    );
    const service = makeService(db, makeConfig(true), makeRegistry("deal.closed"));

    const result = await service.flush();

    expect(result).toMatchObject({ claimed: 1, delivered: 0, fenced: 1 });
    expect(result.retried).toBe(0);
  });
});
