import type { Db } from "../../db/drizzle.module";
import { NotificationDispatchPersistenceService } from "./notification-dispatch-persistence.service";
import { buildNotifIdempotencyKey } from "./notification-dispatch-keys";
import type { DispatchEventInput, NotificationEventDefinition } from "./notification.types";

/**
 * Extracted out of `NotificationDispatchService`; the split moved every row-writing
 * path here, so the tenant column on those writes has to be asserted here too.
 */
const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const USER = "user-1";
const MEMBERSHIP = 7;

const definition: NotificationEventDefinition = {
  eventKey: "build.ticket.assigned",
  displayName: "Ticket assigned",
  description: "A ticket was assigned to you",
  category: "WORK",
  sourceModule: "build",
  defaultType: "INFO",
  defaultPriority: "NORMAL",
  defaultChannels: ["IN_APP"],
  allowedChannels: ["IN_APP"],
  mandatory: false,
  userConfigurable: true,
  dedupeWindowSeconds: 60,
} as unknown as NotificationEventDefinition;

function inputFor(orgId: string): DispatchEventInput {
  return {
    orgId,
    eventKey: "build.ticket.assigned",
    targetUserIds: [USER],
    entityType: "ticket",
    entityId: "5",
  } as unknown as DispatchEventInput;
}

const routingResult = {
  createInApp: true,
  priority: "NORMAL",
  reasonText: "assigned",
  channels: [],
  deferredUntil: null,
} as unknown as Awaited<ReturnType<import("./notification-routing.service").NotificationRoutingService["route"]>>;

function harness() {
  const inserted: Array<Record<string, unknown>> = [];
  const tx = {
    insert: jest.fn(() => ({
      values: jest.fn((v: Record<string, unknown>) => {
        inserted.push(v);
        return {
          onConflictDoNothing: jest.fn(() => ({
            returning: jest.fn().mockResolvedValue([{ id: 1 }]),
          })),
          returning: jest.fn().mockResolvedValue([{ id: 1, createdAt: new Date() }]),
        };
      }),
    })),
    update: jest.fn(() => ({ set: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })) })),
  };
  const db = {
    insert: tx.insert,
    // A bare jest.fn() here never runs the callback, and every assertion inside the
    // transaction would pass without executing.
    transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const service = new NotificationDispatchPersistenceService(db as unknown as Db);
  return { service, inserted, db };
}

describe("NotificationDispatchPersistenceService — cross-tenant isolation", () => {
  it("DENY: a suppression row carries the dispatching org, never another tenant's", async () => {
    const { service, inserted } = harness();

    await service.recordAccessSuppression(inputFor(OWNER_ORG), definition, USER, MEMBERSHIP, "NORMAL");

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.["orgId"]).toBe(OWNER_ORG);
    expect(inserted[0]?.["orgId"]).not.toBe(ATTACKER_ORG);
    expect(inserted[0]?.["status"]).toBe("SUPPRESSED");
    expect(inserted[0]?.["suppressionReason"]).toBe("NO_ACCESS");
  });

  it("DENY: delivery and notification rows are written under the dispatching org", async () => {
    const { service, inserted, db } = harness();

    await service.persistForUser(
      inputFor(OWNER_ORG),
      definition,
      USER,
      MEMBERSHIP,
      routingResult,
      "user@example.com",
      new Map(),
    );

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(inserted.length).toBeGreaterThan(0);
    for (const row of inserted) expect(row["orgId"]).toBe(OWNER_ORG);
    expect(inserted.some((r) => r["orgId"] === ATTACKER_ORG)).toBe(false);
  });

  it("CONTROL: the same event in a different org produces a different idempotency key", () => {
    const ownerKey = buildNotifIdempotencyKey(inputFor(OWNER_ORG), USER, "IN_APP", 60);
    const attackerKey = buildNotifIdempotencyKey(inputFor(ATTACKER_ORG), USER, "IN_APP", 60);

    expect(ownerKey).toContain(OWNER_ORG);
    expect(attackerKey).toContain(ATTACKER_ORG);
    // A shared key would let one tenant's dispatch dedupe away another tenant's.
    expect(ownerKey).not.toBe(attackerKey);
  });

  it("CONTROL: a conflicting idempotency key reports deduped and writes no notification", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const tx = {
      insert: jest.fn(() => ({
        values: jest.fn((v: Record<string, unknown>) => {
          inserted.push(v);
          return {
            onConflictDoNothing: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([]) })),
            returning: jest.fn().mockResolvedValue([]),
          };
        }),
      })),
      update: jest.fn(),
    };
    const db = {
      insert: tx.insert,
      transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    const service = new NotificationDispatchPersistenceService(db as unknown as Db);

    const result = await service.persistForUser(
      inputFor(OWNER_ORG),
      definition,
      USER,
      MEMBERSHIP,
      routingResult,
      null,
      new Map(),
    );

    expect(result.deduped).toBe(true);
    expect(result.createdInApp).toBe(false);
    expect(inserted).toHaveLength(1);
  });
});
