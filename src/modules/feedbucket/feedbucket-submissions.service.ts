import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, ilike, isNull } from "drizzle-orm";
import { feedbucketSubmissions, feedbucketWidgets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { DataScope } from "../access/access.types";
import { applyFeedbucketScope } from "./feedbucket-scope";
import type { ListSubmissionsQuery, UpdateSubmissionInput } from "./feedbucket.schemas";
import type { ProjectsTicketsService } from "../projects/projects-tickets.service";

@Injectable()
export class FeedbucketSubmissionsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, userId: string, query: ListSubmissionsQuery, scope: DataScope) {
    const { page, limit, widgetId, type, status, assigneeId, search } = query;
    const offset = (page - 1) * limit;

    const conditions = [
      eq(feedbucketSubmissions.orgId, orgId),
      isNull(feedbucketSubmissions.deletedAt),
    ];

    const scopeFilter = applyFeedbucketScope(scope, userId);
    if (scopeFilter) conditions.push(scopeFilter);

    if (widgetId !== undefined) conditions.push(eq(feedbucketSubmissions.widgetId, widgetId));
    if (type !== undefined) conditions.push(eq(feedbucketSubmissions.type, type));
    if (status !== undefined) conditions.push(eq(feedbucketSubmissions.status, status));
    if (assigneeId !== undefined) conditions.push(eq(feedbucketSubmissions.assigneeId, assigneeId));
    if (search?.trim()) {
      conditions.push(ilike(feedbucketSubmissions.message, `%${search}%`));
    }

    const where = and(...conditions);

    const [rows, countResult] = await Promise.all([
      this.db.query.feedbucketSubmissions.findMany({
        where,
        with: { widget: true, assignee: true },
        orderBy: [desc(feedbucketSubmissions.createdAt)],
        limit,
        offset,
      }),
      this.db.select({ total: count() }).from(feedbucketSubmissions).where(where),
    ]);

    const total = Number(countResult[0]?.total ?? 0);
    return { data: rows, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(orgId: string, submissionId: number) {
    const submission = await this.db.query.feedbucketSubmissions.findFirst({
      where: and(
        eq(feedbucketSubmissions.id, submissionId),
        eq(feedbucketSubmissions.orgId, orgId),
        isNull(feedbucketSubmissions.deletedAt),
      ),
      with: { widget: true, assignee: true, linkedTicket: true },
    });
    if (!submission) throw new NotFoundException("Submission not found");
    return submission;
  }

  async update(orgId: string, submissionId: number, dto: UpdateSubmissionInput) {
    await this.findOne(orgId, submissionId);
    const patch: Partial<typeof feedbucketSubmissions.$inferInsert> = { updatedAt: new Date() };
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.priority !== undefined) patch.priority = dto.priority;
    if (dto.assigneeId !== undefined) patch.assigneeId = dto.assigneeId;

    const [updated] = await this.db
      .update(feedbucketSubmissions)
      .set(patch)
      .where(and(eq(feedbucketSubmissions.id, submissionId), eq(feedbucketSubmissions.orgId, orgId)))
      .returning();
    return updated;
  }

  async softDelete(orgId: string, submissionId: number) {
    await this.findOne(orgId, submissionId);
    await this.db
      .update(feedbucketSubmissions)
      .set({ deletedAt: new Date() })
      .where(and(eq(feedbucketSubmissions.id, submissionId), eq(feedbucketSubmissions.orgId, orgId)));
  }

  async stats(orgId: string) {
    const rows = await this.db
      .select({
        status: feedbucketSubmissions.status,
        type: feedbucketSubmissions.type,
        cnt: count(),
      })
      .from(feedbucketSubmissions)
      .where(and(eq(feedbucketSubmissions.orgId, orgId), isNull(feedbucketSubmissions.deletedAt)))
      .groupBy(feedbucketSubmissions.status, feedbucketSubmissions.type);

    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};

    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + Number(row.cnt);
      byType[row.type] = (byType[row.type] ?? 0) + Number(row.cnt);
    }

    return { byStatus, byType };
  }

  async convertToTicket(
    orgId: string,
    actingUserId: string,
    submissionId: number,
    ticketsService: ProjectsTicketsService,
  ) {
    const submission = await this.findOne(orgId, submissionId);
    const widget = submission.widget;
    if (!widget) throw new NotFoundException("Submission has no associated widget");
    const projectId = widget.projectId;
    if (!projectId) throw new NotFoundException("Widget has no project linked");

    const ticket = await ticketsService.createFromFeedback(orgId, actingUserId, projectId, {
      title: submission.message.slice(0, 255),
      description: `**Feedback type:** ${submission.type}\n\n${submission.message}`,
      type: widget.defaultTicketType,
    });

    await this.db
      .update(feedbucketSubmissions)
      .set({ linkedTicketId: ticket.id, updatedAt: new Date() })
      .where(and(eq(feedbucketSubmissions.id, submissionId), eq(feedbucketSubmissions.orgId, orgId)));

    return { ticketId: ticket.id };
  }
}
