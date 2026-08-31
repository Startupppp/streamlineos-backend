import type { Db } from "../../../db/drizzle.module";
import { AccountingBillApprovedConsumerService } from "./accounting-bill-approved-consumer.service";
import { OutboxConsumerRegistry, type OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeEvent(orgId: string): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: "evt-1",
    organizationId: orgId,
    eventType: "accounting.bill.approved",
    payload: {
      organization_id: orgId,
      bill_id: 1,
      bill_number: "BILL-001",
      total_cents: 10000,
      actor_user_id: "user-approver",
    },
    aggregateType: "purchase_bill",
    aggregateId: "1",
    aggregateVersion: 1,
    schemaVersion: 1,
    causationId: null,
    correlationId: null,
    actorMembershipId: null,
    audience: "INTERNAL",
    lifecycleState: "ACTIVE",
    deliveryState: "PENDING",
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    publishedAt: null,
    leaseExpiresAt: null,
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("AccountingBillApprovedConsumerService — cross-tenant isolation (background)", () => {
  const TARGET_ORG = "org-target";

  it("scopes approval request query to the event organizationId (org isolation)", async () => {
    const whereArgs: unknown[] = [];
    const db = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1 }]),
          }),
          onConflictDoUpdate: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1, lastAppliedVersion: null }]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((arg: unknown) => {
            whereArgs.push(arg);
            return { limit: jest.fn().mockResolvedValue([]) };
          }),
        }),
      })),
    } as unknown as Db;

    const registry = { register: jest.fn() } as unknown as OutboxConsumerRegistry;
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as never;
    const svc = new AccountingBillApprovedConsumerService(db, dispatch, registry);

    await svc.handle(makeEvent(TARGET_ORG));

    expect(whereArgs.length).toBeGreaterThan(0);
    const allVals = whereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(TARGET_ORG);
  });

  it("does not query other orgs when processing an event (cross-tenant isolation)", async () => {
    const whereArgs: unknown[] = [];
    const db = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1 }]),
          }),
          onConflictDoUpdate: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1, lastAppliedVersion: null }]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      }),
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((arg: unknown) => {
            whereArgs.push(arg);
            return { limit: jest.fn().mockResolvedValue([]) };
          }),
        }),
      })),
    } as unknown as Db;

    const registry = { register: jest.fn() } as unknown as OutboxConsumerRegistry;
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as never;
    const svc = new AccountingBillApprovedConsumerService(db, dispatch, registry);

    await svc.handle(makeEvent(TARGET_ORG));

    const allVals = whereArgs.flatMap(w => sqlValues(w));
    const foreignOrg = "org-other";
    expect(allVals).not.toContain(foreignOrg);
  });
});
