import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, isNull, lt, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { timesheets, projects, tickets, organizationMembers } from "../../../db/schema";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { AccessService } from "../../access/access.service";
import { actingMembershipId } from "../../../common/auth/principal";
import { resolveEntriesScope, applyMembershipScope } from "./timesheets-core-scope";
import { buildEntryShape } from "./lib/entry-shape";
import type { EntriesQuery } from "./dto/entries.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

@Injectable()
export class EntriesReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async listEntries(u: CurrentUserContext, query: EntriesQuery) {
    const scope = await resolveEntriesScope(this.access, u);
    const limit = Math.min(query.limit, 100);
    const pos = decodeCursor(query.cursor);

    const membershipId = actingMembershipId(u.principal);

    const conditions = [
      eq(timesheets.orgId, u.orgId),
      isNull(timesheets.voidedAt),
      applyMembershipScope(scope, membershipId, timesheets.userMembershipId),
    ];

    if (query.userId && scope === "all") {
      const [qMember] = await this.db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, u.orgId),
            eq(organizationMembers.userId, query.userId),
          ),
        )
        .limit(1);
      if (!qMember) return { data: [], pagination: { hasNextPage: false, cursor: null } };
      conditions.push(eq(timesheets.userMembershipId, qMember.id));
    }
    if (query.projectId)
      conditions.push(eq(timesheets.projectId, query.projectId));
    if (query.ticketId)
      conditions.push(eq(timesheets.ticketId, query.ticketId));
    if (query.status) conditions.push(eq(timesheets.status, query.status));
    if (query.startDate)
      conditions.push(gte(timesheets.date, query.startDate));
    if (query.endDate) conditions.push(lte(timesheets.date, query.endDate));
    if (query.billable === "true")
      conditions.push(eq(timesheets.isBillable, true));
    if (query.billable === "false")
      conditions.push(eq(timesheets.isBillable, false));
    if (pos)
      conditions.push(keysetBeforeId(timesheets.date, timesheets.id, pos));

    const dp = alias(projects, "dp");
    const tp = alias(projects, "tp");
    const approverMember = alias(organizationMembers, "approver_member");

    const rawRows = await this.db
      .select({
        id: timesheets.id,
        orgId: timesheets.orgId,
        userMembershipId: timesheets.userMembershipId,
        ticketId: timesheets.ticketId,
        projectId: timesheets.projectId,
        date: timesheets.date,
        hours: timesheets.hours,
        description: timesheets.description,
        isBillable: timesheets.isBillable,
        billingType: timesheets.billingType,
        status: timesheets.status,
        submittedAt: timesheets.submittedAt,
        approvedBy: approverMember.userId,
        approvedAt: timesheets.approvedAt,
        rejectionReason: timesheets.rejectionReason,
        lockedAt: timesheets.lockedAt,
        voidedAt: timesheets.voidedAt,
        invoicingStatus: timesheets.invoicingStatus,
        billRate: timesheets.billRate,
        currency: timesheets.currency,
        rateSource: timesheets.rateSource,
        source: timesheets.source,
        workLink: timesheets.workLink,
        timesheetPeriodId: timesheets.timesheetPeriodId,
        createdAt: timesheets.createdAt,
        updatedAt: timesheets.updatedAt,
        directProjectId: dp.id,
        directProjectName: dp.name,
        ticketRowId: tickets.id,
        ticketTitle: tickets.title,
        ticketTicketNumber: tickets.ticketNumber,
        ticketProjectId: tp.id,
        ticketProjectName: tp.name,
      })
      .from(timesheets)
      .leftJoin(approverMember, and(eq(timesheets.orgId, approverMember.orgId), eq(timesheets.approvedByMembershipId, approverMember.id)))
      .leftJoin(dp, eq(timesheets.projectId, dp.id))
      .leftJoin(tickets, and(eq(timesheets.ticketId, tickets.id), isNull(tickets.deletedAt)))
      .leftJoin(tp, eq(tickets.projectId, tp.id))
      .where(and(...conditions))
      .orderBy(desc(timesheets.date), desc(timesheets.id))
      .limit(limit + 1);

    const page = buildCursorPage(rawRows, limit, (r) => ({
      sortValue: r.date,
      id: String(r.id),
    }));

    return { data: page.data.map(buildEntryShape), pagination: page.pagination };
  }

  async getHoursLoggedInRange(
    orgId: string,
    membershipId: number,
    startDate: string,
    endDate: string,
  ): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`COALESCE(SUM(${timesheets.hours}::numeric), 0)` })
      .from(timesheets)
      .where(
        and(
          eq(timesheets.orgId, orgId),
          eq(timesheets.userMembershipId, membershipId),
          gte(timesheets.date, startDate),
          lt(timesheets.date, endDate),
          isNull(timesheets.voidedAt),
        ),
      );
    return Number(row?.total ?? 0);
  }

  async getEntryById(orgId: string, entryId: number) {
    const dp = alias(projects, "dp");
    const tp = alias(projects, "tp");
    const approverMember = alias(organizationMembers, "approver_member");

    const [row] = await this.db
      .select({
        id: timesheets.id,
        orgId: timesheets.orgId,
        userMembershipId: timesheets.userMembershipId,
        ticketId: timesheets.ticketId,
        projectId: timesheets.projectId,
        date: timesheets.date,
        hours: timesheets.hours,
        description: timesheets.description,
        isBillable: timesheets.isBillable,
        billingType: timesheets.billingType,
        status: timesheets.status,
        submittedAt: timesheets.submittedAt,
        approvedBy: approverMember.userId,
        approvedAt: timesheets.approvedAt,
        rejectionReason: timesheets.rejectionReason,
        lockedAt: timesheets.lockedAt,
        voidedAt: timesheets.voidedAt,
        invoicingStatus: timesheets.invoicingStatus,
        billRate: timesheets.billRate,
        currency: timesheets.currency,
        rateSource: timesheets.rateSource,
        source: timesheets.source,
        workLink: timesheets.workLink,
        timesheetPeriodId: timesheets.timesheetPeriodId,
        createdAt: timesheets.createdAt,
        updatedAt: timesheets.updatedAt,
        directProjectId: dp.id,
        directProjectName: dp.name,
        ticketRowId: tickets.id,
        ticketTitle: tickets.title,
        ticketTicketNumber: tickets.ticketNumber,
        ticketProjectId: tp.id,
        ticketProjectName: tp.name,
      })
      .from(timesheets)
      .leftJoin(approverMember, and(eq(timesheets.orgId, approverMember.orgId), eq(timesheets.approvedByMembershipId, approverMember.id)))
      .leftJoin(dp, eq(timesheets.projectId, dp.id))
      .leftJoin(tickets, and(eq(timesheets.ticketId, tickets.id), isNull(tickets.deletedAt)))
      .leftJoin(tp, eq(tickets.projectId, tp.id))
      .where(and(eq(timesheets.id, entryId), eq(timesheets.orgId, orgId)));

    if (!row) throw new NotFoundException("Time entry not found");
    return buildEntryShape(row);
  }
}
