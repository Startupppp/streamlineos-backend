import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import {
  organizationMembers,
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
import { membershipScope } from "../../timesheets/core/timesheets-core-scope";
import { canActOnPeriod } from "../../timesheets/core/lib/approval-guard";
import { resolveTimesheetsScope } from "./timesheets-scope";
import { formatDateOnly } from "../../../common/date";
import { timeEntryCursorPredicate, timeEntryPage } from "./timesheets-pagination";
import { EntriesPeriodService } from "../../timesheets/core/entries-period.service";
import type {
  BillingSummaryQuery,
  LogTimeInput,
  RejectEntryInput,
  TeamTimesheetsQuery,
  TimeEntriesListQuery,
  TimeEntryPaginationQuery,
  UpdateEntryInput,
} from "./dto/timesheets.schemas";
import { assertProjectInOrg, assertProjectWriteAccess } from "../core";

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
    const limit = query.limit;
    const cursorPredicate = timeEntryCursorPredicate(query.cursor);
    if (query.projectId) await assertProjectInOrg(this.db, user.orgId, query.projectId);
    if (query.ticketId) {
      const ticket = await this.db.query.tickets.findFirst({ where: and(
        eq(tickets.id, query.ticketId), eq(tickets.orgId, user.orgId), isNull(tickets.deletedAt),
        query.projectId ? eq(tickets.projectId, query.projectId) : undefined,
      ), columns: { id: true } });
      if (!ticket) throw new NotFoundException("Ticket not found");
    }

    const read = await resolveTimesheetsScope(this.access, user);
    const membershipId = actingMembershipId(user.principal);

    const conditions = [eq(timesheets.orgId, user.orgId), isNull(timesheets.voidedAt)];
    if (query.ticketId)
      conditions.push(eq(timesheets.ticketId, query.ticketId));
    conditions.push(
      read.compose(
        { tenant: timesheets.orgId, scope: membershipScope(membershipId, timesheets.userMembershipId) },
        ({ sql: w }) => w,
        () => sql`false`,
      ),
    );

    if (query.userId && read.discriminator === "all") {
      const [qMember] = await this.db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, user.orgId), eq(organizationMembers.userId, query.userId)))
        .limit(1);
      conditions.push(eq(timesheets.userMembershipId, qMember?.id ?? -1));
    }
    if (query.startDate) conditions.push(gte(timesheets.date, query.startDate));
    if (query.endDate) conditions.push(lte(timesheets.date, query.endDate));
    if (query.projectId)
      conditions.push(eq(timesheets.projectId, query.projectId));

    const where = and(...conditions);
    const [rows, [totalRow]] = await Promise.all([
      this.db.query.timesheets.findMany({
        where: and(where, cursorPredicate),
        orderBy: [desc(timesheets.date), desc(timesheets.id)],
        limit: limit + 1,
        with: {
          ticket: {
            columns: { id: true, title: true, projectId: true },
            with: { project: { columns: { id: true, name: true, key: true } } },
          },
        },
      }),
      this.db.select({ total: count() }).from(timesheets).where(where),
    ]);

    return timeEntryPage(rows, Number(totalRow?.total ?? 0), limit, query.cursor);
  }

  async updateEntry(
    user: CurrentUserContext,
    entryId: number,
    input: UpdateEntryInput,
  ) {
    const entry = await this.db.query.timesheets.findFirst({
      where: and(eq(timesheets.id, entryId), eq(timesheets.orgId, user.orgId), isNull(timesheets.voidedAt)),
      columns: {
        id: true,
        payrollStatus: true,
        status: true,
        userMembershipId: true,
        ticketId: true,
      },
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

    if (input.hours !== undefined) {
      if (entry.ticketId)
        await this.recomputeTimeSpent(user.orgId, entry.ticketId);
      await this.cache.invalidateNamespace(`build:billing-summary:${user.orgId}`);
    }

    return updated;
  }

  async deleteEntry(user: CurrentUserContext, entryId: number) {
    const entry = await this.db.query.timesheets.findFirst({
      where: and(eq(timesheets.id, entryId), eq(timesheets.orgId, user.orgId), isNull(timesheets.voidedAt)),
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
    await this.cache.invalidateNamespace(`build:billing-summary:${user.orgId}`);

    return { success: true };
  }

  async approveEntry(user: CurrentUserContext, entryId: number) {
    if (!(await this.access.holds(user, "build:timesheets:manage"))) {
      throw new ForbiddenException("Only admins can approve timesheets");
    }

    const actorMembId = actingMembershipId(user.principal);
    if (actorMembId === null)
      throw new ForbiddenException("Approval requires a personal session");

    const entry = await this.db.query.timesheets.findFirst({
      where: and(eq(timesheets.id, entryId), eq(timesheets.orgId, user.orgId), isNull(timesheets.voidedAt)),
    });
    if (!entry) throw new NotFoundException("Time entry not found");

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

    const actorMembId = actingMembershipId(user.principal);
    if (actorMembId === null)
      throw new ForbiddenException("Rejection requires a personal session");

    const entry = await this.db.query.timesheets.findFirst({
      where: and(eq(timesheets.id, entryId), eq(timesheets.orgId, user.orgId), isNull(timesheets.voidedAt)),
    });
    if (!entry) throw new NotFoundException("Time entry not found");

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
    const limit = query.limit;
    const cursorPredicate = timeEntryCursorPredicate(query.cursor);

    const read = await resolveTimesheetsScope(this.access, user);
    if (read.denied) {
      throw new ForbiddenException(
        "You do not have permission to view team timesheets",
      );
    }

    const membershipId = actingMembershipId(user.principal);
    const conditions = [
      eq(timesheets.orgId, user.orgId),
      isNull(timesheets.voidedAt),
      read.compose(
        { tenant: timesheets.orgId, scope: membershipScope(membershipId, timesheets.userMembershipId) },
        ({ sql: w }) => w,
        () => sql`false`,
      ),
    ];
    if (query.userId && read.discriminator === "all") {
      const [qMember] = await this.db
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, user.orgId), eq(organizationMembers.userId, query.userId)))
        .limit(1);
      conditions.push(eq(timesheets.userMembershipId, qMember?.id ?? -1));
    }
    if (query.startDate) conditions.push(gte(timesheets.date, query.startDate));
    if (query.endDate) conditions.push(lte(timesheets.date, query.endDate));
    if (query.status) conditions.push(eq(timesheets.status, query.status));

    const where = and(...conditions);
    const [rows, [totalRow]] = await Promise.all([
      this.db.query.timesheets.findMany({
        where: and(where, cursorPredicate),
        orderBy: [desc(timesheets.date), desc(timesheets.id)],
        limit: limit + 1,
        with: {
          userMember: {
            columns: { id: true, userId: true },
          },
          ticket: {
            columns: { id: true, title: true, projectId: true },
            with: { project: { columns: { id: true, name: true, key: true } } },
          },
        },
      }),
      this.db.select({ total: count() }).from(timesheets).where(where),
    ]);

    return timeEntryPage(rows, Number(totalRow?.total ?? 0), limit, query.cursor);
  }

  async billingSummary(user: CurrentUserContext, query: BillingSummaryQuery) {
    const isAdmin = await this.access.holds(user, "build:manage");
    const { orgId, userId } = user;
    const startDate = query.startDate;
    const endDate = query.endDate;

    const subKey = `${userId}:${isAdmin ? "all" : "self"}:${startDate ?? ""}:${endDate ?? ""}`;

    return this.cache.cachedVersioned(
      `build:billing-summary:${orgId}`,
      subKey,
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

  async listTicketTimeEntries(user: CurrentUserContext, projectId: number, ticketId: number, query: TimeEntryPaginationQuery) {
    return this.listTimeEntries(user, { ...query, projectId, ticketId });
  }

  async logTicketTime(
    user: CurrentUserContext,
    projectId: number,
    ticketId: number,
    input: LogTimeInput,
  ) {
    const membershipId = actingMembershipId(user.principal);

    const ticket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, ticketId),
        eq(tickets.projectId, projectId),
        eq(tickets.orgId, user.orgId),
        isNull(tickets.deletedAt),
      ),
      columns: { projectId: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    await assertProjectWriteAccess(this.db, this.access, user, projectId);

    const entryDate = formatDateOnly(input.date);
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
    await this.cache.invalidateNamespace(`build:billing-summary:${user.orgId}`);

    return entry;
  }
}
