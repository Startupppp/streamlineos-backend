import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";
import { timesheetPeriods } from "../../../../db/schema";
import { PeriodsService } from "../periods.service";
import { ApprovalsService } from "../approvals.service";
import type { AccessService } from "../../../access/access.service";
import type { RateResolverService } from "../rate-resolver.service";
import type { PeriodsReadService } from "../periods-read.service";
import type { PeriodsSubmitService } from "../periods-submit.service";
import type { TimesheetsAuditService } from "../timesheets-audit.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { applyRejection } from "../lib/rejection-transition";

const ORG = "org-1";
const WORKER_MEMBERSHIP = 11;
const APPROVER_MEMBERSHIP = 77;

const WORKER = {
  userId: "usr-worker",
  orgId: ORG,
  isOrgOwner: false,
  principal: humanSessionPrincipal(WORKER_MEMBERSHIP, false),
} as unknown as CurrentUserContext;

// Reopen is an approver action, not the worker's (the worker recalls), so the
// route-clearing cases drive it as the assigned approver (TS-SEC-002).
const APPROVER = {
  userId: "usr-manager",
  orgId: ORG,
  isOrgOwner: false,
  principal: humanSessionPrincipal(APPROVER_MEMBERSHIP, false),
} as unknown as CurrentUserContext;

const ROUTED = {
  id: 42,
  orgId: ORG,
  userMembershipId: WORKER_MEMBERSHIP,
  status: "SUBMITTED",
  currentApproverMembershipId: APPROVER_MEMBERSHIP,
  approvalRoute: { source: "reporting_manager", rung: "reporting_manager" },
  approvalDueAt: new Date("2026-09-23T00:00:00.000Z"),
  approvalEscalatedAt: null,
};

function makeDb(transition: Record<string, unknown> | null = null) {
  const periodSets: Record<string, unknown>[] = [];
  const update = (table: unknown) => ({
    set: (values: Record<string, unknown>) => {
      if (table === timesheetPeriods) periodSets.push(values);
      const result: Promise<undefined> & { returning?: () => Promise<unknown[]> } = Promise.resolve(undefined);
      result.returning = () => Promise.resolve(table === timesheetPeriods && transition ? [transition] : []);
      return { where: () => result };
    },
  });
  const tx = { update };
  const db = {
    update,
    transaction: (body: (handle: unknown) => Promise<unknown>) => body(tx),
  } as unknown as Db;
  return { db, tx, periodSets };
}

function periodsService(db: Db, row: Record<string, unknown>) {
  const reader = {
    getPeriodWithUser: () => Promise.resolve(row),
    mapPeriod: (period: unknown) => period,
  } as unknown as PeriodsReadService;
  const audit = { record: () => Promise.resolve() } as unknown as TimesheetsAuditService;
  const notifications = { emit: () => Promise.resolve({ notificationIds: [] }) } as unknown as NotificationDispatchService;
  // The real guard. These cases act as the assigned approver, so it decides
  // without reaching for delegations and the unused deps stay out of the way.
  const approvals = new ApprovalsService(
    db,
    {} as AccessService,
    audit,
    {} as RateResolverService,
    notifications,
  );
  return new PeriodsService(db, reader, {} as PeriodsSubmitService, audit, notifications, approvals);
}

const CLEARED_ROUTE = {
  currentApproverMembershipId: null,
  approvalRoute: null,
  approvalDueAt: null,
  approvalEscalatedAt: null,
};

describe("a period's approval route lives exactly as long as its submission", () => {
  it("recall clears the approver, the route and the deadline so the escalation sweep cannot chase a withdrawn period", async () => {
    const { db, periodSets } = makeDb();

    await periodsService(db, ROUTED).recallPeriod(WORKER, 42);

    expect(periodSets[0]).toMatchObject({ status: "DRAFT", ...CLEARED_ROUTE });
  });

  it("reopen clears the route from an approved period so a resubmission routes afresh", async () => {
    const { db, periodSets } = makeDb();

    await periodsService(db, { ...ROUTED, status: "APPROVED" }).reopenPeriod(APPROVER, 42);

    expect(periodSets[0]).toMatchObject({ status: "DRAFT", ...CLEARED_ROUTE });
  });

  it("reopen clears the route from a locked period too", async () => {
    const { db, periodSets } = makeDb();

    await periodsService(db, { ...ROUTED, status: "LOCKED" }).reopenPeriod(APPROVER, 42);

    expect(periodSets[0]).toMatchObject({ status: "DRAFT", ...CLEARED_ROUTE });
  });

  it("rejection clears the deadline but keeps the route, so the worker can still see who rejected and why", async () => {
    const { tx, periodSets } = makeDb({ eventSeq: 2, userMembershipId: WORKER_MEMBERSHIP, status: "REJECTED" });

    await applyRejection(
      tx as never,
      { audit: { record: () => Promise.resolve() } } as never,
      WORKER,
      42,
      { input: { reason: "Friday is missing" }, ownerUserId: null, now: new Date("2026-09-22T00:00:00.000Z") },
    );

    expect(periodSets[0]).toMatchObject({ status: "REJECTED", approvalDueAt: null });
    expect(periodSets[0]).not.toHaveProperty("approvalRoute");
    expect(periodSets[0]).not.toHaveProperty("currentApproverMembershipId");
  });
});
