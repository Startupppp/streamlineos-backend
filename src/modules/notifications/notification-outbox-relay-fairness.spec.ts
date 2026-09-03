/**
 * One backlogged tenant used to consume every relay tick, forever.
 *
 * `flush()` claims into a GLOBAL budget (`BATCH_SIZE = 50`) inside `forEachOrg`,
 * which enumerates `ORDER BY organizations.id ASC`. The claim per tenant was
 * `limit ${remaining}` — the whole remaining budget — so the lowest-id organization
 * with a backlog took all 50 rows and every organization sorting after it saw
 * `remaining <= 0` and returned. Their rows stayed PENDING, so they never attempted,
 * so they never reached DEAD, so `alert-dead-outbox` (which fires on DEAD) never
 * fired: notifications for those tenants stopped silently and indefinitely, and
 * whether it happened to you was decided by where your org id sorts.
 *
 * Two things were missing and both are needed. A PER-TENANT CAP, so one tick serves
 * several tenants instead of one; and a ROTATING START, so the tenants a capped tick
 * could not reach are the ones the next tick starts from. With the cap alone, a tick
 * always serves the same first `BATCH_SIZE / ORG_BATCH_CAP` organizations. With
 * rotation alone, a tenant whose backlog exceeds the budget still takes the whole
 * tick whenever its turn comes.
 *
 * This asserts the SET of organizations served, never the total claimed — a total is
 * exactly what the broken shape got right.
 */
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { NotificationDispatchService } from "./notification-dispatch.service";
import {
  NotificationOutboxRelayService,
  OUTBOX_ORG_BATCH_CAP,
} from "./notification-outbox-relay.service";
import type { ForEachOrgOptions } from "../../common/tenant/for-each-org";

const ORGS = ["org-01", "org-02", "org-03", "org-04", "org-05", "org-06", "org-07", "org-08"];
const BACKLOG_PER_ORG = 200;

/**
 * A faithful stand-in for `forEachOrg`: ascending ids, rotated past the cursor,
 * stopping when the caller says its budget is spent. The real one is pinned by
 * `common/tenant/__tests__/for-each-org.spec.ts`; what is under test here is
 * whether the relay uses it correctly.
 */
jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(
    async (
      _db: unknown,
      _sweep: string,
      fn: (tx: unknown, orgId: string) => Promise<void>,
      _intent?: unknown,
      options: ForEachOrgOptions = {},
    ) => {
      const after = options.startAfterOrgId;
      const pivot = after ? ORGS.findIndex((id) => id > after) : 0;
      const order = pivot > 0 ? [...ORGS.slice(pivot), ...ORGS.slice(0, pivot)] : ORGS;
      let visited = 0;
      for (const orgId of order) {
        if (options.stopWhen?.()) break;
        visited += 1;
        await fn(currentTx, orgId);
      }
      return { organizations: visited, succeeded: visited, failed: 0 };
    },
  ),
}));

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(async () => undefined),
}));

/** Rows still owed per org; the claim drains them the way the real UPDATE would. */
const pending = new Map<string, number>();
let currentTx: unknown;

/** Every bound parameter in a drizzle `sql` fragment, however deeply nested. */
function boundValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== "object") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => boundValues(item, seen));
  if (seen.has(value)) return [];
  seen.add(value);
  const record = value as Record<string, unknown>;
  return [
    ...(Array.isArray(record["queryChunks"]) ? boundValues(record["queryChunks"], seen) : []),
    ...("value" in record ? boundValues(record["value"], seen) : []),
  ];
}

function makeTx() {
  return {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((clause: unknown) => ({
          returning: jest.fn().mockImplementation(() => {
            // The org id and the LIMIT are both bound parameters of the claim SQL.
            const bound = boundValues(clause);
            const orgId = bound.find((v): v is string => typeof v === "string" && pending.has(v));
            const limit = bound.find((v): v is number => typeof v === "number");
            if (orgId === undefined || limit === undefined) return Promise.resolve([]);
            const take = Math.min(limit, pending.get(orgId) ?? 0);
            pending.set(orgId, (pending.get(orgId) ?? 0) - take);
            return Promise.resolve(
              Array.from({ length: take }, (_unused, index) => ({
                id: index,
                orgId,
                eventKey: "chat.message.direct",
                dedupeKey: `k-${orgId}-${index}`,
                actorUserId: "u1",
                notifySelf: false,
                targetUserIds: ["u2"],
                entityType: null,
                entityId: null,
                title: null,
                message: null,
                link: null,
                variables: {},
                metadata: null,
                attemptCount: 0,
              })),
            );
          }),
        })),
      }),
    }),
  };
}

describe("notification outbox relay — one tenant cannot own the tick", () => {
  let relay: NotificationOutboxRelayService;
  const served: string[][] = [];

  beforeEach(async () => {
    pending.clear();
    for (const org of ORGS) pending.set(org, BACKLOG_PER_ORG);
    served.length = 0;
    currentTx = makeTx();

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationOutboxRelayService,
        { provide: DRIZZLE, useValue: { select: jest.fn() } },
        { provide: NotificationDispatchService, useValue: { emitNow: jest.fn() } },
      ],
    }).compile();
    relay = moduleRef.get(NotificationOutboxRelayService);
  });

  it("caps what any one organization may claim in a single tick", () => {
    expect(OUTBOX_ORG_BATCH_CAP).toBeGreaterThan(0);
    expect(OUTBOX_ORG_BATCH_CAP).toBeLessThan(50);
  });

  it("serves every backlogged tenant within a few ticks, not just the lowest ids", async () => {
    for (let tick = 0; tick < 5; tick++) {
      const before = new Map(pending);
      await relay.flush();
      served.push(ORGS.filter((org) => (pending.get(org) ?? 0) < (before.get(org) ?? 0)));
    }

    const reached = new Set(served.flat());
    // The head form reached exactly two: org-01 drained 200 and org-02 got the
    // 50-row remainder of one tick. Every other tenant got nothing, in any tick.
    expect([...reached].sort()).toEqual(ORGS);
    // And no tick may be monopolised.
    for (const tickOrgs of served) expect(tickOrgs.length).toBeGreaterThan(1);
  });

  it("stops opening tenant transactions once the tick's budget is spent", async () => {
    const { forEachOrg } = jest.requireMock<{ forEachOrg: jest.Mock }>("../../common/tenant");
    await relay.flush();

    const options = forEachOrg.mock.calls[0]?.[4] as ForEachOrgOptions | undefined;
    expect(typeof options?.stopWhen).toBe("function");
    // 8 tenants, budget 50, cap per tenant: the sweep must stop early rather than
    // open a transaction per remaining tenant to claim nothing.
    const result = await forEachOrg.mock.results[0]?.value;
    expect((result as { organizations: number }).organizations).toBeLessThan(ORGS.length);
  });
});
