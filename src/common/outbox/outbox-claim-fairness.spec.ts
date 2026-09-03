/**
 * Claim fairness across tenants.
 *
 * `claimBatch` takes `BATCH_SIZE - claimed.length` from each organization in
 * turn, and `forEachOrg` enumerates `order by organizations.id asc`. With no
 * rotation those two facts compose into unbounded starvation: an organization
 * whose backlog exceeds the batch size takes the whole tick's budget, every
 * tick, forever, and an organization later in the id order is never reached —
 * however long you wait and whatever the event class.
 *
 * This exercises the REAL `forEachOrg` and the REAL `withTenant` against a fake
 * connection, because the defect lives in how those two compose with
 * `claimBatch` and a mock of either one would answer whatever it was told.
 */
import { Logger } from "@nestjs/common";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { OutboxReportService } from "./outbox-report.service";
import { OutboxConsumerRegistry, type OutboxEventRow } from "./outbox-consumer.registry";
import type { Db } from "../../db/drizzle.module";

const BATCH_SIZE = 50;

/**
 * Interpolated values are raw primitives in a drizzle `sql` template's
 * `queryChunks`; the literal SQL text arrives as `StringChunk` objects, which
 * carry no `queryChunks` and are therefore never descended into.
 */
function interpolated(value: unknown, found: unknown[], seen = new Set<unknown>()): unknown[] {
  if (typeof value === "string" || typeof value === "number") {
    found.push(value);
    return found;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return found;
  seen.add(value);
  const chunks = (value as { queryChunks?: unknown }).queryChunks;
  if (Array.isArray(chunks)) for (const chunk of chunks) interpolated(chunk, found, seen);
  return found;
}

/** The `limit ${remaining}` bound the production claim actually asked for. */
function numericParams(statement: unknown): number[] {
  return interpolated(statement, []).filter((v): v is number => typeof v === "number");
}

function stringParams(statement: unknown): string[] {
  return interpolated(statement, []).filter((v): v is string => typeof v === "string");
}

function makeRow(orgId: string, outboxEventId: number): OutboxEventRow {
  return {
    outboxEventId,
    eventId: `evt-${outboxEventId}`,
    organizationId: orgId,
    aggregateType: "test",
    aggregateId: String(outboxEventId),
    aggregateVersion: 1,
    schemaVersion: 1,
    causationId: null,
    correlationId: null,
    actorMembershipId: null,
    audience: "INTERNAL",
    lifecycleState: "ACTIVE",
    deliveryState: "IN_FLIGHT",
    eventType: "test.event",
    payload: {},
    occurredAt: new Date("2026-09-01T00:00:00.000Z"),
    publishedAt: null,
    leaseExpiresAt: null,
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}

/**
 * A fake connection with a per-organization outbox backlog.
 *
 * The claim's `limit` is read out of the statement the production code built,
 * so the fake never invents the batch bound it is supposed to be testing.
 */
function makeFakeDb(backlog: Map<string, number>) {
  const orgIds = [...backlog.keys()].sort();
  let currentOrgId: string | null = null;
  let nextEventId = 1;
  const claimedPerTick: Record<string, number>[] = [];
  let tick: Record<string, number> = {};

  const execute = (statement: unknown): Promise<unknown[]> => {
    const strings = stringParams(statement);
    const org = strings.find((s) => backlog.has(s));
    if (org) currentOrgId = org;
    return Promise.resolve([{ placement_fence_held: 1 }]);
  };

  function claim(where: unknown): OutboxEventRow[] {
    const org = currentOrgId;
    if (!org) return [];
    const limit = numericParams(where).at(-1) ?? 0;
    const available = backlog.get(org) ?? 0;
    const take = Math.max(0, Math.min(limit, available));
    if (take === 0) return [];
    backlog.set(org, available - take);
    tick[org] = (tick[org] ?? 0) + take;
    return Array.from({ length: take }, () => makeRow(org, nextEventId++));
  }

  const tx = {
    execute,
    update: () => ({
      set: () => ({
        where: (condition: unknown) => ({
          returning: () => Promise.resolve(claim(condition)),
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ status: "ACTIVE" }]) }),
      }),
    }),
  };

  const db = {
    select: () => ({
      from: () => ({ where: () => ({ orderBy: () => Promise.resolve(orgIds.map((id) => ({ id }))) }) }),
    }),
    transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  return {
    db: db as unknown as Db,
    beginTick(): void { tick = {}; },
    endTick(): void { claimedPerTick.push(tick); },
    ticks: claimedPerTick,
  };
}

function makeService(db: Db): OutboxPublisherService {
  const registry = new OutboxConsumerRegistry();
  registry.register({ eventType: "test.event", handle: () => Promise.resolve() });
  return new OutboxPublisherService(
    db,
    { OUTBOX_DISPATCH_ENABLED: "true" } as never,
    registry,
    new OutboxReportService(db),
  );
}

describe("outbox claim fairness", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it("reaches a high-id tenant even while a low-id tenant has a backlog larger than the batch", async () => {
    // org-aaa is mid-bulk-import; org-zzz has one payroll posting intent waiting.
    const backlog = new Map([["org-aaa", 400], ["org-zzz", 1]]);
    const fake = makeFakeDb(backlog);
    const service = makeService(fake.db);

    for (let t = 0; t < 4; t++) {
      fake.beginTick();
      await service.flush();
      fake.endTick();
    }

    const zzzServedOnTick = fake.ticks.findIndex((t) => (t["org-zzz"] ?? 0) > 0);
    expect(zzzServedOnTick).toBeGreaterThanOrEqual(0);
    expect(zzzServedOnTick).toBeLessThan(4);
    expect(backlog.get("org-zzz")).toBe(0);
  });

  it("reaches every tenant within a bounded number of ticks when they all saturate the batch", async () => {
    const orgIds = ["org-a", "org-b", "org-c", "org-d"];
    const backlog = new Map(orgIds.map((id): [string, number] => [id, 200]));
    const fake = makeFakeDb(backlog);
    const service = makeService(fake.db);

    for (let t = 0; t < orgIds.length; t++) {
      fake.beginTick();
      await service.flush();
      fake.endTick();
    }

    const served = new Set(fake.ticks.flatMap((t) => Object.keys(t)));
    expect([...served].sort()).toEqual(orgIds);
  });

  it("does not lose throughput for a single-tenant deployment", async () => {
    const backlog = new Map([["org-only", 400]]);
    const fake = makeFakeDb(backlog);
    const service = makeService(fake.db);

    fake.beginTick();
    const result = await service.flush();
    fake.endTick();

    expect(result.claimed).toBe(BATCH_SIZE);
  });

  it("stops opening tenant transactions once the batch is full", async () => {
    const backlog = new Map([["org-aaa", 400], ["org-bbb", 5], ["org-ccc", 5]]);
    const fake = makeFakeDb(backlog);
    const service = makeService(fake.db);
    const transaction = jest.spyOn(
      fake.db as unknown as { transaction: (fn: unknown) => unknown },
      "transaction",
    );

    fake.beginTick();
    await service.flush();
    fake.endTick();

    // One transaction to claim org-aaa's 50, then the enumeration must stop —
    // plus the per-event lifecycle read / deliver / mark transactions, which are
    // driven by the 50 claimed rows, not by the tenant count.
    const claimTransactions = transaction.mock.calls.length - BATCH_SIZE * 3;
    expect(claimTransactions).toBe(1);
  });
});
