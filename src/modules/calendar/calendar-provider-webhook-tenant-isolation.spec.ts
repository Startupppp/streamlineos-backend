jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CalendarProviderWebhookService } from "./calendar-provider-webhook.service";
import { actingMembershipId, humanSessionPrincipal } from "../../common/auth/principal";
import type { Db } from "../../db/drizzle.module";

const mockedRunInTx = runInNewTenantTransaction as jest.MockedFunction<typeof runInNewTenantTransaction>;

const ORG_A = "org-webhook-a";
const ORG_B = "org-webhook-b";
const KNOWN_ORGS: readonly string[] = [ORG_A, ORG_B];
const SHARED_EXTERNAL_ID = "google-evt-shared";
const LOCAL_UPDATED_AT = new Date("2026-09-01T12:00:00Z");
const NEWER_PROVIDER_TIMESTAMP = new Date(LOCAL_UPDATED_AT.getTime() + 5_000).toISOString();

const ACTOR_A = humanSessionPrincipal(4201, false);
const ACTOR_B = humanSessionPrincipal(8401, false);

function membershipIdOf(principal: ReturnType<typeof humanSessionPrincipal>): number {
  const id = actingMembershipId(principal);
  if (id === null) throw new Error("test actor must carry a membershipId");
  return id;
}

interface StoredEvent {
  orgId: string;
  id: number;
  updatedAt: Date;
  localVersion: number;
  integrationConnectionId: number | null;
  externalEventId: string;
  createdByMembershipId: number;
}

interface StoredMember {
  orgId: string;
  membershipId: number;
  userId: string;
}

interface StoredQueueRow {
  orgId: string;
  eventId: number;
  state: string;
}

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined) return [value];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const node = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(node.queryChunks ? sqlValues(node.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(node, "value") ? sqlValues(node.value, seen) : []),
  ];
}

function boundOrgIds(bound: readonly unknown[]): string[] {
  return bound.filter((v): v is string => typeof v === "string" && KNOWN_ORGS.includes(v));
}

interface HarnessOptions {
  events: StoredEvent[];
  members: StoredMember[];
  queue?: StoredQueueRow[];
  ignoreTenantPredicate?: boolean;
}

interface Harness {
  db: Db;
  txOrgIds: string[];
  wheres: unknown[];
  inserted: Record<string, unknown>[];
}

/** Rows are filtered by the predicate the service actually built: when it binds no org value the org filter is not applied, so a dropped `eq(orgId, …)` really does expose the other tenant's row instead of narrowing to none. */
function makeHarness(options: HarnessOptions): Harness {
  const { events, members, queue = [], ignoreTenantPredicate = false } = options;
  const txOrgIds: string[] = [];
  const wheres: unknown[] = [];
  const inserted: Record<string, unknown>[] = [];

  const orgFilter = (bound: readonly unknown[], rowOrgId: string): boolean => {
    if (ignoreTenantPredicate) return true;
    const orgs = boundOrgIds(bound);
    if (orgs.length === 0) return true;
    return orgs.includes(rowOrgId);
  };

  let selectCall = 0;
  const tx = {
    select: jest.fn().mockImplementation(() => {
      const callIdx = selectCall++;
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((predicate: unknown) => {
            wheres.push(predicate);
            const bound = sqlValues(predicate);
            if (callIdx === 0) {
              const matched = events.filter(
                (row) => bound.includes(row.externalEventId) && orgFilter(bound, row.orgId),
              );
              return { limit: jest.fn().mockResolvedValue(matched) };
            }
            const matched = queue.filter(
              (row) => bound.includes(row.eventId) && bound.includes(row.state) && orgFilter(bound, row.orgId),
            );
            return { limit: jest.fn().mockResolvedValue(matched.map((row) => ({ id: row.eventId }))) };
          }),
        }),
      };
    }),
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockImplementation((arg: { where?: unknown }) => {
          wheres.push(arg.where);
          const bound = sqlValues(arg.where);
          const matched = members.find(
            (row) => bound.includes(row.membershipId) && orgFilter(bound, row.orgId),
          );
          return Promise.resolve(matched);
        }),
      },
    },
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
        inserted.push(row);
        return Promise.resolve([]);
      }),
    }),
  };

  mockedRunInTx.mockImplementation(async (_db, orgId, cb) => {
    txOrgIds.push(orgId);
    return cb(tx as never);
  });

  return { db: {} as unknown as Db, txOrgIds, wheres, inserted };
}

function eventFor(orgId: string, overrides: Partial<StoredEvent> = {}): StoredEvent {
  const owningActor = orgId === ORG_A ? ACTOR_A : ACTOR_B;
  return {
    orgId,
    id: orgId === ORG_A ? 42 : 84,
    updatedAt: LOCAL_UPDATED_AT,
    localVersion: 3,
    integrationConnectionId: orgId === ORG_A ? 7 : 9,
    externalEventId: SHARED_EXTERNAL_ID,
    createdByMembershipId: membershipIdOf(owningActor),
    ...overrides,
  };
}

const MEMBER_A: StoredMember = { orgId: ORG_A, membershipId: membershipIdOf(ACTOR_A), userId: "user-a" };
const MEMBER_B: StoredMember = { orgId: ORG_B, membershipId: membershipIdOf(ACTOR_B), userId: "user-b" };

beforeEach(() => {
  jest.resetAllMocks();
});

describe("CalendarProviderWebhookService — the actors this suite uses", () => {
  it("builds both actors through the canonical principal helper as non-owners carrying a membershipId", () => {
    for (const actor of [ACTOR_A, ACTOR_B]) {
      expect(actor.kind).toBe("human-session");
      expect(actor).toMatchObject({ isOrgOwner: false });
      expect(actingMembershipId(actor)).toEqual(expect.any(Number));
    }
    expect(membershipIdOf(ACTOR_A)).not.toBe(membershipIdOf(ACTOR_B));
  });
});

describe("CalendarProviderWebhookService — cross-tenant isolation", () => {
  it("returns not_found when the externalEventId exists only in a different org, never that org's event", async () => {
    const harness = makeHarness({ events: [eventFor(ORG_B)], members: [MEMBER_B] });
    const svc = new CalendarProviderWebhookService(harness.db);

    const result = await svc.handleProviderWebhook(ORG_A, SHARED_EXTERNAL_ID, NEWER_PROVIDER_TIMESTAMP);

    expect(result.action).toBe("not_found");
    expect(harness.inserted).toHaveLength(0);
  });

  it("resolves its own org's event when both orgs hold the same provider externalEventId", async () => {
    const harness = makeHarness({ events: [eventFor(ORG_A), eventFor(ORG_B)], members: [MEMBER_A, MEMBER_B] });
    const svc = new CalendarProviderWebhookService(harness.db);

    const result = await svc.handleProviderWebhook(ORG_A, SHARED_EXTERNAL_ID, NEWER_PROVIDER_TIMESTAMP);

    expect(result.action).toBe("requeued");
    expect(harness.inserted).toHaveLength(1);
    expect(harness.inserted[0]).toMatchObject({
      orgId: ORG_A,
      eventId: 42,
      connectionId: 7,
      payload: { userId: MEMBER_A.userId },
    });
  });

  it("opens every tenant transaction with the caller's org id, so the GUC never carries another tenant", async () => {
    const harness = makeHarness({ events: [eventFor(ORG_A), eventFor(ORG_B)], members: [MEMBER_A, MEMBER_B] });
    const svc = new CalendarProviderWebhookService(harness.db);

    await svc.handleProviderWebhook(ORG_A, SHARED_EXTERNAL_ID, NEWER_PROVIDER_TIMESTAMP);

    expect(harness.txOrgIds.length).toBeGreaterThan(0);
    expect(new Set(harness.txOrgIds)).toEqual(new Set([ORG_A]));
  });

  it("binds the caller's org into every predicate it builds, and never the other org", async () => {
    const harness = makeHarness({ events: [eventFor(ORG_A), eventFor(ORG_B)], members: [MEMBER_A, MEMBER_B] });
    const svc = new CalendarProviderWebhookService(harness.db);

    await svc.handleProviderWebhook(ORG_A, SHARED_EXTERNAL_ID, NEWER_PROVIDER_TIMESTAMP);

    expect(harness.wheres.length).toBeGreaterThanOrEqual(3);
    for (const predicate of harness.wheres) {
      expect(boundOrgIds(sqlValues(predicate))).toEqual([ORG_A]);
    }
  });

  it("does not resolve the other org's creator membership, so a cross-tenant event can never be re-queued", async () => {
    const harness = makeHarness({ events: [eventFor(ORG_B)], members: [MEMBER_B] });
    const svc = new CalendarProviderWebhookService(harness.db);

    const result = await svc.handleProviderWebhook(ORG_A, SHARED_EXTERNAL_ID, NEWER_PROVIDER_TIMESTAMP);

    expect(result.action).toBe("not_found");
    expect(harness.txOrgIds).not.toContain(ORG_B);
    expect(harness.inserted).toHaveLength(0);
  });

  it("ignores another org's in-flight sync row, so org B cannot suppress org A's re-queue", async () => {
    const harness = makeHarness({
      events: [eventFor(ORG_A), eventFor(ORG_B)],
      members: [MEMBER_A, MEMBER_B],
      queue: [{ orgId: ORG_B, eventId: 42, state: "IN_FLIGHT" }],
    });
    const svc = new CalendarProviderWebhookService(harness.db);

    const result = await svc.handleProviderWebhook(ORG_A, SHARED_EXTERNAL_ID, NEWER_PROVIDER_TIMESTAMP);

    expect(result.action).toBe("requeued");
    expect(harness.inserted[0]).toMatchObject({ orgId: ORG_A, eventId: 42 });
  });
});

describe("CalendarProviderWebhookService — BITE: the tenant predicate is what stops the leak", () => {
  it("serves org B's event, connection and creator to an org A webhook once the org conjunct is dropped", async () => {
    const harness = makeHarness({
      events: [eventFor(ORG_B)],
      members: [MEMBER_B],
      ignoreTenantPredicate: true,
    });
    const svc = new CalendarProviderWebhookService(harness.db);

    const result = await svc.handleProviderWebhook(ORG_A, SHARED_EXTERNAL_ID, NEWER_PROVIDER_TIMESTAMP);

    expect(result.action).toBe("requeued");
    expect(harness.inserted[0]).toMatchObject({
      orgId: ORG_A,
      eventId: 84,
      connectionId: 9,
      payload: { userId: MEMBER_B.userId },
    });
  });

  it("lets org B's in-flight sync row discard an org A webhook once the org conjunct is dropped", async () => {
    const harness = makeHarness({
      events: [eventFor(ORG_A)],
      members: [MEMBER_A],
      queue: [{ orgId: ORG_B, eventId: 42, state: "IN_FLIGHT" }],
      ignoreTenantPredicate: true,
    });
    const svc = new CalendarProviderWebhookService(harness.db);

    const result = await svc.handleProviderWebhook(ORG_A, SHARED_EXTERNAL_ID, NEWER_PROVIDER_TIMESTAMP);

    expect(result.action).toBe("discarded");
    expect(harness.inserted).toHaveLength(0);
  });
});
