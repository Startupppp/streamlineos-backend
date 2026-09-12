import { makeCountingDb } from "../../../db/__tests__/counting-db";
import type { Db } from "../../../db/drizzle.types";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CacheService } from "../../../common/cache/cache.service";
import type { AccessService } from "../../access/access.service";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { ApprovalsBulkService } from "./approvals-bulk.service";
import { ApprovalsService } from "./approvals.service";
import { RateResolverService } from "./rate-resolver.service";
import { TimesheetsAuditService } from "./timesheets-audit.service";

/**
 * `bulkApprove` used to call `approveSinglePeriod` once per period, and then
 * update the resolved rates one statement per rate group. Both are now set-based,
 * so the whole path is a fixed number of statements.
 *
 * Every collaborator here is the REAL service sharing the counting handle —
 * delegation lookup, actor resolution, rate resolution and the audit trail all
 * spend statements, and a per-row shape anywhere in that chain would show up in
 * the total. Stubbing them would move the N+1 out of the measurement instead of
 * out of the code.
 *
 * Every period still announces its own approval and lock (the payroll handoff
 * waits on each period's `timesheets.period.locked`), so the path also reads the
 * workers' user ids once and writes every period's events in one outbox INSERT.
 * Only the notification dispatcher is a stub: it sends after the commit and
 * spends no statement of this handle.
 */

const ORG = "org-approvals-bulk";
const ACTOR_MEMBERSHIP = 7;
const BATCH_SIZES = [1, 50] as const;
const BULK_APPROVE_STATEMENTS = 17;

function repeat<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_unused, index) => make(index));
}

const USER: CurrentUserContext = {
  userId: "user-approver",
  orgId: ORG,
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(ACTOR_MEMBERSHIP, true),
};

/** Matches every query, so no rate falls through to the project-member lookup. */
const GLOBAL_RATE = {
  id: 1,
  projectId: null,
  userMembershipId: null,
  taskId: null,
  clientId: null,
  priority: 0,
  billRate: "100.00",
  costRate: "50.00",
  currency: "USD",
  effectiveFrom: null,
  effectiveTo: null,
};

function selectPlan(size: number): unknown[] {
  const periodIds = repeat(size, (index) => ({ id: index + 1 }));
  const candidates = repeat(size, (index) => ({
    id: index + 1,
    userMembershipId: 500 + index,
    currentApproverMembershipId: 900 + index,
  }));
  if (size === 0) return [periodIds, candidates];
  return [
    periodIds,
    candidates,
    [], // active delegations to the actor
    [
      {
        id: ACTOR_MEMBERSHIP,
        orgId: ORG,
        userId: USER.userId,
        role: "OWNER",
        isOwner: true,
        status: "ACTIVE",
      },
    ],
    [{ id: "person-7" }], // organization person of the actor's membership
    [{ lockAfterApproval: true }],
    // the workers' user ids, which the events and the notices are addressed by
    repeat(size, (index) => ({ id: 500 + index, userId: `user-worker-${index}` })),
    repeat(size, (index) => ({
      id: index + 1,
      projectId: 1,
      userMembershipId: 500 + index,
      ticketId: null,
      date: "2026-06-01",
    })),
    [GLOBAL_RATE],
    [{ currency: "USD" }],
    [], // previous audit row hash
  ];
}

/** The batch period UPDATE reads back every row, `event_seq` already bumped for approved + locked. */
function updatePlan(size: number): unknown[] {
  return [
    repeat(size, (index) => ({
      id: index + 1,
      eventSeq: 2,
      userMembershipId: 500 + index,
      periodStart: "2026-06-01",
      periodEnd: "2026-06-07",
      status: "APPROVED",
      totalHours: "8.00",
      billableHours: "8.00",
      nonBillableHours: "0.00",
    })),
    [], // the entries UPDATE returns nothing
  ];
}

function harness(size: number) {
  const counting = makeCountingDb({ select: selectPlan(size), update: updatePlan(size) });
  const db = counting.db as Db;
  const cache = {
    cachedVersioned: (
      _namespace: string,
      _key: string,
      loader: () => Promise<unknown>,
    ): Promise<unknown> => loader(),
  } as unknown as CacheService;

  const audit = new TimesheetsAuditService(db);
  const rateResolver = new RateResolverService(db, cache);
  const notifications = {
    emit: (): Promise<unknown> => Promise.resolve({ notificationIds: [] }),
  } as unknown as NotificationDispatchService;
  const approvals = new ApprovalsService(
    db,
    {} as unknown as AccessService,
    audit,
    rateResolver,
    notifications,
  );

  return {
    ...counting,
    service: new ApprovalsBulkService(db, audit, approvals, rateResolver),
    periodIds: repeat(size, (index) => index + 1),
  };
}

describe("ApprovalsBulkService.bulkApprove — statement count", () => {
  it("approves 50 periods in the same number of statements as 1", async () => {
    const totals: number[] = [];

    for (const size of BATCH_SIZES) {
      const { service, statements, countOf, periodIds } = harness(size);

      await expect(service.bulkApprove(USER, { periodIds })).resolves.toEqual({
        approved: size,
        skipped: 0,
      });

      expect(statements()).toBe(BULK_APPROVE_STATEMENTS);
      // Two set-based UPDATEs — the periods and their entries — never one per period.
      expect(countOf("update")).toBe(2);
      // One UPDATE … FROM (VALUES …) carries every resolved rate, and the audit
      // chain takes its per-organisation advisory lock once for the whole batch.
      expect(countOf("execute")).toBe(2);
      // One multi-row audit INSERT, and one outbox INSERT carrying every period's events.
      expect(countOf("insert")).toBe(2);
      totals.push(statements());
    }

    expect(totals[0]).toBe(totals[1]);
    expect(totals).toEqual([BULK_APPROVE_STATEMENTS, BULK_APPROVE_STATEMENTS]);
  });

  it("resolves every delegation and every rate in one read each", async () => {
    const { service, countOf, periodIds } = harness(50);

    await service.bulkApprove(USER, { periodIds });

    // 50 periods with 50 distinct current approvers, one delegation read; one read
    // of the 50 workers' user ids; and one rate read plus one default-currency read
    // for 50 billable entries.
    expect(countOf("select")).toBe(11);
  });

  it("issues two statements and no write for an empty batch", async () => {
    const { service, statements, countOf } = harness(0);

    await expect(service.bulkApprove(USER, { periodIds: [] })).resolves.toEqual({
      approved: 0,
      skipped: 0,
    });

    expect(statements()).toBe(2);
    expect(countOf("select")).toBe(2);
    expect(countOf("update")).toBe(0);
    expect(countOf("execute")).toBe(0);
    expect(countOf("insert")).toBe(0);
    expect(countOf("transaction")).toBe(0);
  });
});
