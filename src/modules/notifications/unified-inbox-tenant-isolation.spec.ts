import type { Db } from "../../db/drizzle.module";
import { UnifiedInboxService } from "./unified-inbox.service";
import type { AccessService } from "../access/access.service";
import type { MailService } from "../mail/mail.service";
import type { BroadcastsService } from "./broadcasts.service";
import type { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import type { UnifiedInboxQuery } from "./dto/unified-inbox.schemas";
import { humanSessionPrincipal } from "../../common/auth/principal";

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

describe("UnifiedInboxService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const VICTIM_USER = "user-victim";
  const CALLER_USER = "user-caller";
  /**
   * The recipient key is the MEMBERSHIP, not the user id: every index on
   * `notifications` leads `(org_id, membership_id, …)` and the `user_id` form seq
   * scanned every partition (10,231 blocks vs 24, measured on the perf seed). A
   * membership is org-scoped by construction, so it carries the tenant boundary
   * with it — but the org predicate is asserted below regardless, because relying on
   * that implication is how a cross-tenant read gets shipped.
   */
  const CALLER_MEMBERSHIP = 4242;
  const VICTIM_MEMBERSHIP = 9001;

  function makeNotifDb(): { db: Db; where: jest.Mock } {
    const where = jest.fn();
    const limit = jest.fn().mockResolvedValue([]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const leftJoin = jest.fn();
    const from = jest.fn();
    const builder = { from, leftJoin, where, orderBy, limit };
    from.mockReturnValue(builder);
    leftJoin.mockReturnValue({ where });
    where.mockReturnValue({ orderBy });

    const db = {
      select: jest.fn().mockReturnValue(builder),
    } as unknown as Db;
    return { db, where };
  }

  function makeAccess(): AccessService {
    return { holds: jest.fn().mockResolvedValue(false) } as unknown as AccessService;
  }

  function makeMail(): MailService {
    return { listMessages: jest.fn() } as unknown as MailService;
  }

  function makeBroadcasts(): BroadcastsService {
    return { listInboxPage: jest.fn().mockResolvedValue([]) } as unknown as BroadcastsService;
  }

  function makeBuildApprovals(): BuildApprovalsInboxService {
    return { getInboxPage: jest.fn().mockResolvedValue([]) } as unknown as BuildApprovalsInboxService;
  }

function makeRegistry() {
  return { list: jest.fn().mockReturnValue([]), register: jest.fn() } as unknown as import('../attention/approval-adapter.registry').ApprovalAdapterRegistry;
}

  const query: UnifiedInboxQuery = { kinds: ["notification"], limit: 25, unreadOnly: false };

  function caller() {
    return {
      orgId: ATTACKER_ORG,
      userId: CALLER_USER,
      principal: humanSessionPrincipal(CALLER_MEMBERSHIP, false),
    };
  }

  it("scopes notification query to the requesting org — cross-tenant isolation", async () => {
    const { db, where } = makeNotifDb();
    const svc = new UnifiedInboxService(db, makeAccess(), makeMail(), makeBroadcasts(), makeBuildApprovals(), makeRegistry());

    const result = await svc.list(ATTACKER_ORG, CALLER_USER, query, caller() as never);

    expect(result.items).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("does not return notifications addressed to a different recipient — user isolation", async () => {
    const { db, where } = makeNotifDb();
    const svc = new UnifiedInboxService(db, makeAccess(), makeMail(), makeBroadcasts(), makeBuildApprovals(), makeRegistry());

    const result = await svc.list(ATTACKER_ORG, CALLER_USER, query, caller() as never);

    expect(result.items).toHaveLength(0);
    const predicateValues = sqlValues(where.mock.calls[0]?.[0]);
    expect(predicateValues).toContain(CALLER_MEMBERSHIP);
    expect(predicateValues).not.toContain(VICTIM_MEMBERSHIP);
    expect(predicateValues).not.toContain(VICTIM_USER);
  });

  /**
   * The recipient comes from the verified principal, never from the `userId`
   * argument — so a caller cannot widen the read by naming someone else, and a
   * principal that holds no membership in this org reads nothing rather than
   * falling back to a scan of the whole tenant.
   */
  it("reads nothing for a principal with no membership, rather than scanning the tenant", async () => {
    const { db, where } = makeNotifDb();
    const svc = new UnifiedInboxService(db, makeAccess(), makeMail(), makeBroadcasts(), makeBuildApprovals(), makeRegistry());

    const result = await svc.list(
      ATTACKER_ORG,
      VICTIM_USER,
      query,
      { orgId: ATTACKER_ORG, userId: VICTIM_USER, principal: { kind: "account-only" } } as never,
    );

    expect(result.items).toHaveLength(0);
    expect(where).not.toHaveBeenCalled();
  });
});
