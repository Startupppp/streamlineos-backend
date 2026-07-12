import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { projectMembers, projects, tickets, timesheets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { applyScope } from "../access/apply-scope";
import { resolveTimesheetsScope } from "./timesheets-scope";
import { formatDateOnly } from "./date.helpers";
import type {
  BillingSummaryQuery,
  LogTimeInput,
  RejectEntryInput,
  TeamTimesheetsQuery,
  TimeEntriesListQuery,
  UpdateEntryInput,
} from "./dto/timesheets.schemas";

@Injectable()
export class TimesheetsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  private async recomputeTimeSpent(ticketId: number): Promise<void> {
    const totalHours = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${timesheets.hours}::numeric), 0)` })
      .from(timesheets)
      .where(eq(timesheets.ticketId, ticketId));

    await this.db
      .update(tickets)
      .set({ timeSpent: totalHours[0]?.total?.toString() ?? "0" })
      .where(eq(tickets.id, ticketId));
  }

  async listTimeEntries(user: CurrentUserContext, query: TimeEntriesListQuery) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const offset = (page - 1) * limit;

    const scope = await resolveTimesheetsScope(this.access, user);

    const conditions = [eq(timesheets.orgId, user.orgId)];
    if (query.ticketId) conditions.push(eq(timesheets.ticketId, query.ticketId));
    conditions.push(applyScope(scope, user.userId, { ownerColumn: timesheets.userId }));
    if (query.userId && scope === "all") conditions.push(eq(timesheets.userId, query.userId));
    if (query.startDate) conditions.push(gte(timesheets.date, query.startDate));
    if (query.endDate) conditions.push(lte(timesheets.date, query.endDate));

    const entries = await this.db.query.timesheets.findMany({
      where: and(...conditions),
      orderBy: [desc(timesheets.date)],
      limit,
      offset,
      with: { ticket: { with: { project: true } } },
    });

    return query.projectId
      ? entries.filter((e) => e.ticket?.projectId === query.projectId)
      : entries;
  }

  async updateEntry(user: CurrentUserContext, entryId: number, input: UpdateEntryInput) {
    const entry = await this.db.query.timesheets.findFirst({
      where: and(eq(timesheets.id, entryId), eq(timesheets.orgId, user.orgId)),
      with: { ticket: { with: { project: true } } },
    });
    if (!entry) throw new NotFoundException("Time entry not found");
    if (entry.payrollStatus === "EXPORTED") {
      throw new ConflictException("This entry was included in a payroll export and can no longer be modified. Use a correction entry instead.");
    }
    if (entry.status !== "PENDING") {
      throw new ForbiddenException("Cannot edit a time entry that has already been reviewed");
    }

    const perms = await this.access.resolveUserPermissions(user.orgId, user.userId);
    const isOwnerOrAdmin = perms.has("projects:timesheets:manage");
    if (!isOwnerOrAdmin && entry.userId !== user.userId) {
      throw new ForbiddenException("You can only edit your own time entries");
    }

    const updateData: { description?: string; hours?: string; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (input.description !== undefined) updateData.description = input.description;
    if (input.hours !== undefined) updateData.hours = input.hours.toString();

    const [updated] = await this.db
      .update(timesheets)
      .set(updateData)
      .where(eq(timesheets.id, entryId))
      .returning();

    if (input.hours !== undefined && entry.ticketId) {
      await this.recomputeTimeSpent(entry.ticketId);
    }

    return updated;
  }

  async deleteEntry(user: CurrentUserContext, entryId: number) {
    const entry = await this.db.query.timesheets.findFirst({
      where: and(eq(timesheets.id, entryId), eq(timesheets.orgId, user.orgId)),
    });
    if (!entry) throw new NotFoundException("Time entry not found");
    if (entry.payrollStatus === "EXPORTED") {
      throw new ConflictException("This entry was included in a payroll export and can no longer be modified. Use a correction entry instead.");
    }
    if (entry.status !== "PENDING") {
      throw new ForbiddenException("Cannot delete a time entry that has already been reviewed");
    }

    const perms = await this.access.resolveUserPermissions(user.orgId, user.userId);
    const isOwnerOrAdmin = perms.has("projects:timesheets:manage");
    if (!isOwnerOrAdmin && entry.userId !== user.userId) {
      throw new ForbiddenException("You can only delete your own time entries");
    }

    const ticketId = entry.ticketId;
    await this.db.delete(timesheets).where(eq(timesheets.id, entryId));

    if (ticketId) await this.recomputeTimeSpent(ticketId);

    return { success: true };
  }

  async approveEntry(user: CurrentUserContext, entryId: number) {
    const perms = await this.access.resolveUserPermissions(user.orgId, user.userId);
    if (!perms.has("projects:timesheets:manage")) {
      throw new ForbiddenException("Only admins can approve timesheets");
    }

    const entry = await this.db.query.timesheets.findFirst({
      where: and(eq(timesheets.id, entryId), eq(timesheets.orgId, user.orgId)),
    });
    if (!entry) throw new NotFoundException("Time entry not found");
    if (entry.payrollStatus === "EXPORTED") {
      throw new ConflictException("This entry was included in a payroll export and can no longer be modified. Use a correction entry instead.");
    }
    if (entry.status !== "PENDING") {
      throw new BadRequestException("Only pending entries can be approved");
    }

    await this.db
      .update(timesheets)
      .set({
        status: "APPROVED",
        approvedBy: user.userId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(timesheets.id, entryId));

    return { success: true };
  }

  async rejectEntry(user: CurrentUserContext, entryId: number, input: RejectEntryInput) {
    const perms = await this.access.resolveUserPermissions(user.orgId, user.userId);
    if (!perms.has("projects:timesheets:manage")) {
      throw new ForbiddenException("Only admins can reject timesheets");
    }

    const entry = await this.db.query.timesheets.findFirst({
      where: and(eq(timesheets.id, entryId), eq(timesheets.orgId, user.orgId)),
    });
    if (!entry) throw new NotFoundException("Time entry not found");
    if (entry.payrollStatus === "EXPORTED") {
      throw new ConflictException("This entry was included in a payroll export and can no longer be modified. Use a correction entry instead.");
    }
    if (entry.status !== "PENDING") {
      throw new BadRequestException("Only pending entries can be rejected");
    }

    await this.db
      .update(timesheets)
      .set({ status: "REJECTED", rejectionReason: input.reason ?? null, updatedAt: new Date() })
      .where(eq(timesheets.id, entryId));

    return { success: true };
  }

  async teamTimesheets(user: CurrentUserContext, query: TeamTimesheetsQuery) {
    const perms = await this.access.resolveUserPermissions(user.orgId, user.userId);
    if (!perms.has("projects:timesheets:manage")) {
      throw new ForbiddenException("Only admins can view team timesheets");
    }

    const conditions = [eq(timesheets.orgId, user.orgId)];
    if (query.userId) conditions.push(eq(timesheets.userId, query.userId));
    if (query.startDate) conditions.push(gte(timesheets.date, query.startDate));
    if (query.endDate) conditions.push(lte(timesheets.date, query.endDate));
    if (query.status) conditions.push(eq(timesheets.status, query.status));

    return this.db.query.timesheets.findMany({
      where: and(...conditions),
      orderBy: [desc(timesheets.date)],
      with: {
        user: { columns: { id: true, firstName: true, lastName: true, email: true, image: true } },
        ticket: { with: { project: true } },
      },
    });
  }

  async billingSummary(user: CurrentUserContext, query: BillingSummaryQuery) {
    const perms = await this.access.resolveUserPermissions(user.orgId, user.userId);
    const isAdmin = perms.has("projects:manage");
    const { orgId, userId } = user;
    const startDate = query.startDate;
    const endDate = query.endDate;

    const key = `projects:billing-summary:${orgId}:${userId}:${isAdmin ? "all" : "self"}:${startDate ?? ""}:${endDate ?? ""}`;

    return this.cache.cached(
      key,
      () => {
        const conditions = [eq(timesheets.orgId, orgId), eq(timesheets.isBillable, true)];
        if (!isAdmin) conditions.push(eq(timesheets.userId, userId));
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

  listTicketTimeEntries(orgId: string, ticketId: number) {
    return this.db.query.timesheets.findMany({
      where: and(eq(timesheets.ticketId, ticketId), eq(timesheets.orgId, orgId)),
      orderBy: [desc(timesheets.date)],
      with: { ticket: { with: { project: true } } },
    });
  }

  async logTicketTime(user: CurrentUserContext, ticketId: number, input: LogTimeInput) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, user.orgId)),
      columns: { projectId: true },
      with: { project: { columns: { managerId: true, id: true } } },
    });
    if (!ticket?.project) throw new NotFoundException("Ticket not found");

    const perms = await this.access.resolveUserPermissions(user.orgId, user.userId);
    const isOwnerOrAdmin = perms.has("projects:manage");
    const isManager = ticket.project.managerId === user.userId;

    if (!isOwnerOrAdmin && !isManager) {
      const membership = await this.db.query.projectMembers.findFirst({
        where: and(
          eq(projectMembers.projectId, ticket.project.id),
          eq(projectMembers.userId, user.userId),
        ),
      });
      if (!membership) {
        throw new ForbiddenException("You must be a project member to log time.");
      }
    }

    const [entry] = await this.db
      .insert(timesheets)
      .values({
        orgId: user.orgId,
        userId: user.userId,
        ticketId,
        date: formatDateOnly(new Date(input.date)),
        hours: input.hours.toString(),
        description: input.description ?? null,
        imageUrl: input.imageUrl?.trim() || null,
        workLink: input.workLink?.trim() || null,
      })
      .returning();

    await this.recomputeTimeSpent(ticketId);

    return entry;
  }
}
