import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  timesheetPeriods,
  timesheetSettings,
  timesheets,
  organizationMembers,
  users,
} from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { actingMembershipId } from "../../../common/auth/principal";
import { resolveEntriesScope, applyMembershipScope } from "./timesheets-core-scope";
import type { PeriodsQuery } from "./dto/periods.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

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
      rejectionReason: row.rejectionReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.userEmail
        ? { user: { membershipId: row.userMembershipId, name: row.userName ?? row.userEmail, email: row.userEmail } }
        : {}),
    };
  }

  async listPeriods(u: CurrentUserContext, query: PeriodsQuery) {
    const scope = await resolveEntriesScope(this.access, u);
    const limit = Math.min(query.limit, 100);
    const membershipId = actingMembershipId(u.principal);

    const conditions = [
      eq(timesheetPeriods.orgId, u.orgId),
      applyMembershipScope(scope, membershipId, timesheetPeriods.userMembershipId),
    ];

    if (query.userId && scope === "all") {
      const [qMember] = await this.db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, u.orgId), eq(organizationMembers.userId, query.userId)))
        .limit(1);
      if (qMember) conditions.push(eq(timesheetPeriods.userMembershipId, qMember.id));
    }
    if (query.status) conditions.push(eq(timesheetPeriods.status, query.status));

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
        rejectionReason: timesheetPeriods.rejectionReason,
        createdAt: timesheetPeriods.createdAt,
        updatedAt: timesheetPeriods.updatedAt,
        userEmail: users.email,
        userName: users.name,
      })
      .from(timesheetPeriods)
      .leftJoin(ownerMember, and(eq(timesheetPeriods.orgId, ownerMember.orgId), eq(timesheetPeriods.userMembershipId, ownerMember.id)))
      .leftJoin(users, eq(ownerMember.userId, users.id))
      .where(and(...conditions))
      .orderBy(desc(timesheetPeriods.periodStart))
      .limit(limit);

    return rows.map((r) => this.mapPeriod(r));
  }

  async getPeriod(u: CurrentUserContext, periodId: number) {
    const row = await this.getPeriodWithUser(u.orgId, periodId);
    if (!row) throw new NotFoundException("Period not found");

    const scope = await resolveEntriesScope(this.access, u);
    const canSeeOthers =
      u.isOrgOwner ||
      scope === "all" ||
      scope === "team";

    if (row.userMembershipId !== actingMembershipId(u.principal) && !canSeeOthers) {
      throw new ForbiddenException("You do not have access to this period");
    }

    const periodEntries = await this.db.query.timesheets.findMany({
      where: and(
        eq(timesheets.timesheetPeriodId, periodId),
        eq(timesheets.orgId, u.orgId),
      ),
      orderBy: [desc(timesheets.date)],
    });

    return { period: this.mapPeriod(row), entries: periodEntries };
  }
}
