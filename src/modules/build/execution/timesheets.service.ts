import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import {
  organizationMembers,
  projectMembers,
  projects,
  tickets,
  timesheets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { applyMembershipScope } from "../../timesheets/core/timesheets-core-scope";
import { canActOnPeriod } from "../../timesheets/core/lib/approval-guard";
import { resolveTimesheetsScope } from "./timesheets-scope";
import { formatDateOnly } from "../../../common/date";
import { EntriesPeriodService } from "../../timesheets/core/entries-period.service";
import type {
  BillingSummaryQuery,
  LogTimeInput,
  RejectEntryInput,
  TeamTimesheetsQuery,
  TimeEntriesListQuery,
  UpdateEntryInput,
} from "./dto/timesheets.schemas";
import { assertTicketInOrg } from "../core/project-access";

@Injectable()
export class TimesheetsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
    private readonly periodService: EntriesPeriodService,
  ) {}

  private async recomputeTimeSpent(
    orgId: string,
    ticketId: number,
  ): Promise<void> {
    const [row] = await this.db
      .select({
        total: sql<number>`COALESCE(SUM(${timesheets.hours}::numeric), 0)`,
      })
      .from(timesheets)
      .where(
        and(
          eq(timesheets.ticketId, ticketId),
          eq(timesheets.orgId, orgId),
          isNull(timesheets.voidedAt),
        ),
      );

    await this.db
      .update(tickets)
      .set({ timeSpent: row?.total?.toString() ?? "0" })
      .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)));
  }

  async listTimeEntries(user: CurrentUserContext, query: TimeEntriesListQuery) {
    const page = query.page ?? 1;
    const limit = query.limit;
    const offset = (page - 1) * limit;

    const scope = await resolveTimesheetsScope(this.access, user);
    const membershipId = actingMembershipId(user.principal);

    const conditions = [eq(timesheets.orgId, user.orgId)];
    if (query.ticketId)
      conditions.push(eq(timesheets.ticketId, query.ticketId));
    conditions.push(applyMembershipScope(scope, membershipId, timesheets.userMembershipId));

    if (query.userId && scope === "all") {
      const [qMember] = await this.db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, user.orgId), eq(organizationMembers.userId, query.userId)))
        .limit(1);
      if (qMember) conditions.push(eq(timesheets.userMembershipId, qMember.id));
    }
    if (query.startDate) conditions.push(gte(timesheets.date, query.startDate));
    if (query.endDate) conditions.push(lte(timesheets.date, query.endDate));
    if (query.projectId)
      conditions.push(eq(timesheets.projectId, query.projectId));

    return this.db.query.timesheets.findMany({
      where: and(...conditions),
      orderBy: [desc(timesheets.date)],
      limit,
      offset,
      with: {
        ticket: {
          columns: { id: true, title: true, projectId: true },
          with: { project: { columns: { id: true, name: true, key: true } } },
        },
      },
    });
  }

  async updateEntry(
    user: CurrentUserContext,
    entryId: number,
    input: UpdateEntryInput,
  ) {
    const entry = await this.db.query.timesheets.findFirst({
      where: and(eq(timesheets.id, entryId), eq(timesheets.orgId, user.orgId)),
      with: { ticket: { with: { project: true } } },
    });
    if (!entry) throw new NotFoundException("Time entry not found");
    if (entry.payrollStatus === "EXPORTED") {
      throw new ConflictException(
        "This entry was included in a payroll export and can no longer be modified. Use a correction entry instead.",
      );
    }
    if (entry.status !== "PENDING") {
      throw new ForbiddenException(
        "Cannot edit a time entry that has already been reviewed",
      );
    }

    const isOwnerOrAdmin = await this.access.holds(
      user,
      "build:timesheets:manage",
    );
    if (!isOwnerOrAdmin && entry.userMembershipId !== actingMembershipId(user.principal)) {
      throw new ForbiddenException("You can only edit your own time entries");
    }

    const updateData: {
      description?: string;
      hours?: string;
      updatedAt: Date;
    } = {
      updatedAt: new Date(),
    };
    if (input.description !== undefined)
      updateData.description = input.description;
    if (input.hours !== undefined) updateData.hours = input.hours.toString();

    const [updated] = await this.db
      .update(timesheets)
      .set(updateData)
      .where(and(eq(timesheets.id, entryId), eq(timesheets.orgId, user.orgId)))
      .returning();

    if (input.hours !== undefined && entry.ticketId) {
      await this.recomputeTimeSpent(user.orgId, entry.ticketId);
    }

    return updated;
  }

  async deleteEntry(user: CurrentUserContext, entryId: number) {
    const entry = await this.db.query.timesheets.findFirst({
      where: and(eq(timesheets.id, entryId), eq(timesheets.orgId, user.orgId)),
    });
    if (!entry) throw new NotFoundException("Time entry not found");
    if (entry.payrollStatus === "EXPORTED") {
      throw new ConflictException(
        "This entry was included in a payroll export and can no longer be modified. Use a correction entry instead.",
      );
    }
    if (entry.status !== "PENDING") {
      throw new ForbiddenException(
        "Cannot delete a time entry that has already been reviewed",
      );
    }

    const isOwnerOrAdmin = await this.access.holds(
      user,
      "build:timesheets:manage",
    );
    if (!isOwnerOrAdmin && entry.userMembershipId !== actingMembershipId(user.principal)) {
      throw new ForbiddenException("You can only delete your own time entries");
    }

    const ticketId = entry.ticketId;
    await this.db
      .delete(timesheets)
      .where(and(eq(timesheets.id, entryId), eq(timesheets.orgId, user.orgId)));

    if (ticketId) await this.recomputeTimeSpent(user.orgId, ticketId);

    return { success: true };
  }

  async approveEntry(user: CurrentUserContext, entryId: number) {
    if (!(await this.access.holds(user, "build:timesheets:manage"))) {
      throw new ForbiddenException("Only admins can approve timesheets");
    }

    const entry = await this.db.query.timesheets.findFirst({
      where: and(eq(timesheets.id, entryId), eq(timesheets.orgId, user.orgId)),
    });
    if (!entry) throw new NotFoundException("Time entry not found");

    const actorMembId = actingMembershipId(user.principal);
    const decision = canActOnPeriod(
      { membershipId: actorMembId, isOrgOwner: !!user.isOrgOwner },
      { userMembershipId: entry.userMembershipId, currentApproverMembershipId: null },
    );
    if (!decision.allowed) throw new ForbiddenException(decision.reason);

    if (entry.payrollStatus === "EXPORTED")
      throw new ConflictException(
        "This entry was included in a payroll export and can no longer be modified. Use a correction entry instead.",
      );

    if (entry.status !== "PENDING")
      throw new BadRequestException("Only pending entries can be approved");

    await this.db
      .update(timesheets)
      .set({
        status: "APPROVED",
        approvedByMembershipId: actorMembId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(timesheets.id, entryId), eq(timesheets.orgId, user.orgId)));

    return { success: true };
  }

  async rejectEntry(
    user: CurrentUserContext,
    entryId: number,
    input: RejectEntryInput,
  ) {
    if (!(await this.access.holds(user, "build:timesheets:manage"))) {
      throw new ForbiddenException("Only admins can reject timesheets");
    }

    const entry = await this.db.query.timesheets.findFirst({
      where: and(eq(timesheets.id, entryId), eq(timesheets.orgId, user.orgId)),
    });
    if (!entry) throw new NotFoundException("Time entry not found");

    const actorMembId = actingMembershipId(user.principal);
    const decision = canActOnPeriod(
      { membershipId: actorMembId, isOrgOwner: !!user.isOrgOwner },
      { userMembershipId: entry.userMembershipId, currentApproverMembershipId: null },
    );
    if (!decision.allowed) throw new ForbiddenException(decision.reason);
    if (entry.payrollStatus === "EXPORTED") {
      throw new ConflictException(
        "This entry was included in a payroll export and can no longer be modified. Use a correction entry instead.",
      );
    }
    if (entry.status !== "PENDING") {
      throw new BadRequestException("Only pending entries can be rejected");
    }

    await this.db
      .update(timesheets)
      .set({
        status: "REJECTED",
        rejectionReason: input.reason ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(timesheets.id, entryId), eq(timesheets.orgId, user.orgId)));

    return { success: true };
  }

  async teamTimesheets(user: CurrentUserContext, query: TeamTimesheetsQuery) {
    const scope = await resolveTimesheetsScope(this.access, user);
    if (scope === "none") {
      throw new ForbiddenException(
        "You do not have permission to view team timesheets",
      );
    }

    const membershipId = actingMembershipId(user.principal);
    const conditions = [
      eq(timesheets.orgId, user.orgId),
      applyMembershipScope(scope, membershipId, timesheets.userMembershipId),
    ];
    if (query.userId && scope === "all") {
      const [qMember] = await this.db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, user.orgId), eq(organizationMembers.userId, query.userId)))
        .limit(1);
      if (qMember) conditions.push(eq(timesheets.userMembershipId, qMember.id));
    }
    if (query.startDate) conditions.push(gte(timesheets.date, query.startDate));
    if (query.endDate) conditions.push(lte(timesheets.date, query.endDate));
    if (query.status) conditions.push(eq(timesheets.status, query.status));

    return this.db.query.timesheets.findMany({
      where: and(...conditions),
      orderBy: [desc(timesheets.date)],
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
      with: {
        userMember: {
          columns: { id: true, userId: true },
        },
        ticket: {
          columns: { id: true, title: true, projectId: true },
          with: { project: { columns: { id: true, name: true, key: true } } },
        },
      },
    });
  }

  async billingSummary(user: CurrentUserContext, query: BillingSummaryQuery) {
    const isAdmin = await this.access.holds(user, "build:manage");
    const { orgId, userId } = user;
    const startDate = query.startDate;
    const endDate = query.endDate;

    const key = `projects:billing-summary:${orgId}:${userId}:${isAdmin ? "all" : "self"}:${startDate ?? ""}:${endDate ?? ""}`;

    return this.cache.cached(
      key,
      async () => {
        const conditions = [
          eq(timesheets.orgId, orgId),
          eq(timesheets.isBillable, true),
        ];
        if (!isAdmin) {
          const [selfMember] = await this.db
            .select({ id: organizationMembers.id })
            .from(organizationMembers)
            .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
            .limit(1);
          if (selfMember) conditions.push(eq(timesheets.userMembershipId, selfMember.id));
        }
        if (startDate) conditions.push(gte(timesheets.date, startDate));
        if (endDate) conditions.push(lte(timesheets.date, endDate));

        return this.db
          .select({
            projectId: tickets.projectId,
            projectName: projects.name,
            totalHours: sql<number>`COALESCE(SUM(${timesheets.hours}::numeric), 0)`,
          })
          .from(timesheets)
          .innerJoin(tickets, eq(timesheets.ticketId, tickets.id))
          .innerJoin(projects, eq(tickets.projectId, projects.id))
          .where(and(...conditions))
          .groupBy(tickets.projectId, projects.name);
      },
      30,
    );
  }

  async listTicketTimeEntries(orgId: string, ticketId: number) {
    await assertTicketInOrg(this.db, orgId, ticketId);
    return this.db.query.timesheets.findMany({
      where: and(
        eq(timesheets.ticketId, ticketId),
        eq(timesheets.orgId, orgId),
      ),
      orderBy: [desc(timesheets.date)],
      limit: 200,
      with: {
        ticket: {
          columns: { id: true, title: true, projectId: true },
          with: { project: { columns: { id: true, name: true, key: true } } },
        },
      },
    });
  }

  async logTicketTime(
    user: CurrentUserContext,
    ticketId: number,
    input: LogTimeInput,
  ) {
    const membershipId = actingMembershipId(user.principal);

    const ticket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, ticketId),
        eq(tickets.orgId, user.orgId),
        isNull(tickets.deletedAt),
      ),
      columns: { projectId: true },
      with: { project: { columns: { managerMembershipId: true, id: true } } },
    });
    if (!ticket?.project) throw new NotFoundException("Ticket not found");

    const isOwnerOrAdmin = await this.access.holds(user, "build:manage");
    const isManager =
      (membershipId !== null && ticket.project.managerMembershipId === membershipId) ||
      false;

    if (!isOwnerOrAdmin && !isManager) {
      const membership = await this.db.query.projectMembers.findFirst({
        columns: { id: true },
        where: and(
          eq(projectMembers.orgId, user.orgId),
          eq(projectMembers.projectId, ticket.project.id),
          eq(projectMembers.membershipId, membershipId ?? -1),
        ),
      });
      if (!membership) {
        throw new ForbiddenException(
          "You must be a project member to log time.",
        );
      }
    }

    const entryDate = formatDateOnly(new Date(input.date));
    const settings = await this.periodService.loadSettings(user.orgId);
    const workWeekStart = settings?.workWeekStart ?? 1;

    const entry = await this.db.transaction(async (tx) => {
      const periodId = membershipId !== null
        ? await this.periodService.getOrCreatePeriod(
            user.orgId,
            membershipId,
            entryDate,
            workWeekStart,
            tx,
          )
        : null;

      const [inserted] = await tx
        .insert(timesheets)
        .values({
          orgId: user.orgId,
          userMembershipId: membershipId,
          projectId: ticket.projectId,
          ticketId,
          date: entryDate,
          hours: input.hours.toString(),
          description: input.description ?? null,
          imageUrl: input.imageUrl?.trim() || null,
          workLink: input.workLink?.trim() || null,
          status: "PENDING",
          invoicingStatus: "UNINVOICED",
          payrollStatus: "UNPROCESSED",
          source: "MANUAL",
          timesheetPeriodId: periodId,
        })
        .returning();
      return inserted;
    });

    await this.recomputeTimeSpent(user.orgId, ticketId);

    return entry;
  }
}
