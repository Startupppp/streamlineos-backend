import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { TimesheetApprovalRoute } from "../../../db/schema/timesheets/periods";
import {
  timesheetPeriods,
  timesheetSettings,
  timesheets,
  organizationMembers,
  users,
} from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import type { ScopedRead } from "../../access/scoped-read";
import { actingMembershipId } from "../../../common/auth/principal";
import {
  approvalQueueTeamScope,
  membershipTeamScope,
  resolveApprovalScope,
  resolveEntriesScope,
} from "./timesheets-core-scope";
import type { PeriodsQuery } from "./dto/periods.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const PERIOD_ENTRIES_CEILING = 500;

@Injectable()
export class PeriodsReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async getSettings(orgId: string) {
    const [s] = await this.db
      .select()
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, orgId))
      .limit(1);
    return s;
  }

  async unsettledForMembers(orgId: string, membershipIds: readonly number[], endedBefore: string, limit: number) {
    if (membershipIds.length === 0) return [];
    return this.db
      .select({
        id: timesheetPeriods.id,
        userMembershipId: timesheetPeriods.userMembershipId,
        periodStart: timesheetPeriods.periodStart,
        periodEnd: timesheetPeriods.periodEnd,
        status: timesheetPeriods.status,
        totalHours: timesheetPeriods.totalHours,
      })
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.orgId, orgId),
          inArray(timesheetPeriods.userMembershipId, [...membershipIds]),
          inArray(timesheetPeriods.status, ["OPEN", "DRAFT", "REJECTED"]),
          lt(timesheetPeriods.periodEnd, endedBefore),
        ),
      )
      .orderBy(asc(timesheetPeriods.periodEnd), asc(timesheetPeriods.id))
      .limit(Math.min(limit, 100));
  }

  async getPeriodWithUser(orgId: string, periodId: number) {
    const ownerMember = alias(organizationMembers, "owner_member");
    const rows = await this.db
      .select({
        id: timesheetPeriods.id,
        orgId: timesheetPeriods.orgId,
        userMembershipId: timesheetPeriods.userMembershipId,
        periodStart: timesheetPeriods.periodStart,
        periodEnd: timesheetPeriods.periodEnd,
        status: timesheetPeriods.status,
        totalHours: timesheetPeriods.totalHours,
        billableHours: timesheetPeriods.billableHours,
        nonBillableHours: timesheetPeriods.nonBillableHours,
        submittedAt: timesheetPeriods.submittedAt,
        approvedAt: timesheetPeriods.approvedAt,
        rejectedAt: timesheetPeriods.rejectedAt,
        lockedAt: timesheetPeriods.lockedAt,
        currentApproverMembershipId: timesheetPeriods.currentApproverMembershipId,
        approvalRoute: timesheetPeriods.approvalRoute,
        approvalDueAt: timesheetPeriods.approvalDueAt,
        approvalEscalatedAt: timesheetPeriods.approvalEscalatedAt,
        rejectionReason: timesheetPeriods.rejectionReason,
        createdAt: timesheetPeriods.createdAt,
        updatedAt: timesheetPeriods.updatedAt,
        userEmail: users.email,
        userName: users.name,
      })
      .from(timesheetPeriods)
      .leftJoin(ownerMember, and(eq(timesheetPeriods.orgId, ownerMember.orgId), eq(timesheetPeriods.userMembershipId, ownerMember.id)))
      .leftJoin(users, eq(ownerMember.userId, users.id))
      .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, orgId)));

    return rows[0] ?? null;
  }

  mapPeriod(row: {
    id: number;
    orgId: string;
    userMembershipId: number | null;
    periodStart: string;
    periodEnd: string;
    status: string;
    totalHours: string;
    billableHours: string;
    nonBillableHours: string;
    submittedAt: Date | null;
    approvedAt: Date | null;
    rejectedAt: Date | null;
    lockedAt: Date | null;
    currentApproverMembershipId: number | null;
    approvalRoute: TimesheetApprovalRoute | null;
    approvalDueAt: Date | null;
    approvalEscalatedAt: Date | null;
    rejectionReason: string | null;
    createdAt: Date;
    updatedAt: Date;
    userEmail?: string | null;
    userName?: string | null;
  }) {
    return {
      id: row.id,
      orgId: row.orgId,
      userMembershipId: row.userMembershipId,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      status: row.status,
      totalHours: row.totalHours,
      billableHours: row.billableHours,
      nonBillableHours: row.nonBillableHours,
      submittedAt: row.submittedAt,
      approvedAt: row.approvedAt,
      rejectedAt: row.rejectedAt,
      lockedAt: row.lockedAt,
      currentApproverMembershipId: row.currentApproverMembershipId,
      approvalRoute: row.approvalRoute,
      approvalDueAt: row.approvalDueAt,
      approvalEscalatedAt: row.approvalEscalatedAt,
      rejectionReason: row.rejectionReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.userEmail
        ? { user: { membershipId: row.userMembershipId, name: row.userName ?? row.userEmail, email: row.userEmail } }
        : {}),
    };
  }

  async listPeriods(u: CurrentUserContext, query: PeriodsQuery) {
    const read = await resolveEntriesScope(this.access, u);
    const limit = Math.min(query.limit, 100);
    const membershipId = actingMembershipId(u.principal);

    let requestedMembershipId: number | undefined;
    if (query.userId && read.discriminator === "all") {
      const [qMember] = await this.db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, u.orgId), eq(organizationMembers.userId, query.userId)))
        .limit(1);
      if (qMember) requestedMembershipId = qMember.id;
    }

    const ownerMember = alias(organizationMembers, "owner_member");
    return read.read(
      {
        tenant: timesheetPeriods.orgId,
        scope: membershipTeamScope(u.orgId, u.userId, membershipId, timesheetPeriods.userMembershipId),
        and: [
          requestedMembershipId !== undefined ? eq(timesheetPeriods.userMembershipId, requestedMembershipId) : undefined,
          query.status ? eq(timesheetPeriods.status, query.status) : undefined,
        ],
      },
      async ({ sql: where }) => {
        const rows = await this.db
          .select({
            id: timesheetPeriods.id,
            orgId: timesheetPeriods.orgId,
            userMembershipId: timesheetPeriods.userMembershipId,
            periodStart: timesheetPeriods.periodStart,
            periodEnd: timesheetPeriods.periodEnd,
            status: timesheetPeriods.status,
            totalHours: timesheetPeriods.totalHours,
            billableHours: timesheetPeriods.billableHours,
            nonBillableHours: timesheetPeriods.nonBillableHours,
            submittedAt: timesheetPeriods.submittedAt,
            approvedAt: timesheetPeriods.approvedAt,
            rejectedAt: timesheetPeriods.rejectedAt,
            lockedAt: timesheetPeriods.lockedAt,
            currentApproverMembershipId: timesheetPeriods.currentApproverMembershipId,
            approvalRoute: timesheetPeriods.approvalRoute,
            approvalDueAt: timesheetPeriods.approvalDueAt,
            approvalEscalatedAt: timesheetPeriods.approvalEscalatedAt,
            rejectionReason: timesheetPeriods.rejectionReason,
            createdAt: timesheetPeriods.createdAt,
            updatedAt: timesheetPeriods.updatedAt,
            userEmail: users.email,
            userName: users.name,
          })
          .from(timesheetPeriods)
          .leftJoin(ownerMember, and(eq(timesheetPeriods.orgId, ownerMember.orgId), eq(timesheetPeriods.userMembershipId, ownerMember.id)))
          .leftJoin(users, eq(ownerMember.userId, users.id))
          .where(where)
          .orderBy(desc(timesheetPeriods.periodStart))
          .limit(limit);

        return rows.map((r) => this.mapPeriod(r));
      },
      () => [],
    );
  }

  async getPeriod(u: CurrentUserContext, periodId: number) {
    const row = await this.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");

    const read = await resolveEntriesScope(this.access, u);
    const scope = read.rawScope("decides whether this already-fetched row needs the team predicate re-probed; all/own/none are answerable without a query");
    const ownRow = row.userMembershipId === actingMembershipId(u.principal);
    const allowed =
      u.isOrgOwner ||
      scope === "all" ||
      ownRow ||
      (scope === "team" && (await this.periodInScope(read, u, periodId))) ||
      (await this.periodInApprovalScope(u, periodId));

    if (!allowed) {
      throw new ForbiddenException("You do not have access to this period");
    }

    const periodEntries = await this.listPeriodEntries(u.orgId, periodId);

    return { period: this.mapPeriod(row), entries: periodEntries };
  }

  /**
   * The approval queue's own predicate, re-asked about one period id.
   *
   * A reporting manager holds `timesheets:approvals:view` at `own` and no team
   * key, so nothing in the entries scope can justify the row they were sent to
   * approve. Asking `approvalQueueTeamScope` - the predicate behind both the
   * approvals queue and the overdue queue - keeps the detail read and those
   * queues inseparable at every scope the key can be held at, including `team`,
   * where the overdue queue reaches direct reports whose unsubmitted periods
   * have no assigned approver to match on.
   */
  private async periodInApprovalScope(u: CurrentUserContext, periodId: number): Promise<boolean> {
    const read = await resolveApprovalScope(this.access, u);
    const membershipId = actingMembershipId(u.principal);
    return read.read(
      {
        tenant: timesheetPeriods.orgId,
        scope: approvalQueueTeamScope(u.orgId, u.userId, membershipId),
        and: [eq(timesheetPeriods.id, periodId)],
      },
      async ({ sql: where }) =>
        (await this.db.select({ id: timesheetPeriods.id }).from(timesheetPeriods).where(where).limit(1)).length > 0,
      () => false,
    );
  }

  /** Re-asks the list predicate about one period id, so the authorization answer and the row predicate cannot disagree. */
  private periodInScope(read: ScopedRead, u: CurrentUserContext, periodId: number): Promise<boolean> {
    const membershipId = actingMembershipId(u.principal);
    return read.read(
      {
        tenant: timesheetPeriods.orgId,
        scope: membershipTeamScope(u.orgId, u.userId, membershipId, timesheetPeriods.userMembershipId),
        and: [eq(timesheetPeriods.id, periodId)],
      },
      async ({ sql: where }) =>
        (await this.db.select({ id: timesheetPeriods.id }).from(timesheetPeriods).where(where).limit(1)).length > 0,
      () => false,
    );
  }

  listPeriodEntries(orgId: string, periodId: number) {
    return this.db.query.timesheets.findMany({
      where: and(
        eq(timesheets.timesheetPeriodId, periodId),
        eq(timesheets.orgId, orgId),
      ),
      columns: {
        id: true,
        orgId: true,
        userMembershipId: true,
        ticketId: true,
        projectId: true,
        date: true,
        hours: true,
        description: true,
        isBillable: true,
        billingType: true,
        status: true,
        submittedAt: true,
        approvedAt: true,
        approvedByMembershipId: true,
        rejectionReason: true,
        voidedAt: true,
        invoicingStatus: true,
        billRate: true,
        currency: true,
        timesheetPeriodId: true,
        createdAt: true,
        updatedAt: true,
      },
      with: { project: { columns: { id: true, name: true } } },
      orderBy: [desc(timesheets.date)],
      limit: PERIOD_ENTRIES_CEILING,
    });
  }
}
