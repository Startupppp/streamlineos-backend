import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, ilike, isNull, like } from "drizzle-orm";
import { feedbucketAttachments, feedbucketSubmissions, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { ScopedRead } from "../access/scoped-read";
import { feedbucketScope } from "./feedbucket-scope";
import type { ListSubmissionsQuery, UpdateSubmissionInput } from "./feedbucket.schemas";
import type { ProjectsTicketsService } from "../build/core/projects-tickets.service";

@Injectable()
export class FeedbucketSubmissionsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(read: ScopedRead, query: ListSubmissionsQuery, membershipId: number | null) {
    const orgId = read.orgId;
    const { page, limit, widgetId, type, status, assigneeId, search } = query;
    const offset = (page - 1) * limit;

    const domain = [
      widgetId !== undefined ? eq(feedbucketSubmissions.widgetId, widgetId) : undefined,
      type !== undefined ? eq(feedbucketSubmissions.type, type) : undefined,
      status !== undefined ? eq(feedbucketSubmissions.status, status) : undefined,
      isNull(feedbucketSubmissions.deletedAt),
    ];
    if (assigneeId !== undefined) {
      const membership = await this.db.query.organizationMembers.findFirst({ where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, assigneeId)), columns: { id: true } });
      domain.push(eq(feedbucketSubmissions.assigneeMembershipId, membership?.id ?? -1));
    }
    if (search?.trim()) {
      domain.push(ilike(feedbucketSubmissions.message, `%${search}%`));
    }

    return read.read(
      {
        tenant: feedbucketSubmissions.orgId,
        scope: feedbucketScope(read.actorId, membershipId),
        and: domain,
      },
      async ({ sql: where }) => {
        const [rows, countResult] = await Promise.all([
          this.db.query.feedbucketSubmissions.findMany({
            where,
            columns: { consoleLogs: false, networkLogs: false },
            with: {
              widget: true,
            },
            orderBy: [desc(feedbucketSubmissions.createdAt)],
            limit,
            offset,
          }),
          this.db.select({ total: count() }).from(feedbucketSubmissions).where(where),
        ]);

        const total = Number(countResult[0]?.total ?? 0);
        return { data: rows, total, page, limit, totalPages: Math.ceil(total / limit) };
      },
      () => ({ data: [], total: 0, page, limit, totalPages: 0 }),
    );
  }

  async findOne(orgId: string, submissionId: number) {
    const [submission, recordingRows] = await Promise.all([
      this.db.query.feedbucketSubmissions.findFirst({
        where: and(
          eq(feedbucketSubmissions.id, submissionId),
          eq(feedbucketSubmissions.orgId, orgId),
          isNull(feedbucketSubmissions.deletedAt),
        ),
        with: {
          widget: true,
          linkedTicket: true,
        },
      }),
      this.db
        .select({ fileUrl: feedbucketAttachments.fileUrl })
        .from(feedbucketAttachments)
        .where(
          and(
            eq(feedbucketAttachments.submissionId, submissionId),
            eq(feedbucketAttachments.orgId, orgId),
            like(feedbucketAttachments.mimeType, "video/%"),
          ),
        )
        .orderBy(desc(feedbucketAttachments.createdAt))
        .limit(1),
    ]);
    if (!submission) throw new NotFoundException("Submission not found");
    return { ...submission, recordingUrl: recordingRows[0]?.fileUrl ?? null };
  }

  async update(orgId: string, submissionId: number, dto: UpdateSubmissionInput) {
    await this.findOne(orgId, submissionId);
    const patch: Partial<typeof feedbucketSubmissions.$inferInsert> = { updatedAt: new Date() };
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.priority !== undefined) patch.priority = dto.priority;
    if (dto.assigneeId !== undefined) {
      const membership = dto.assigneeId === null ? null : await this.db.query.organizationMembers.findFirst({ where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, dto.assigneeId)), columns: { id: true } });
      patch.assigneeMembershipId = membership?.id ?? null;
    }

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

  async stats(read: ScopedRead, membershipId: number | null) {
    return read.read(
      {
        tenant: feedbucketSubmissions.orgId,
        scope: feedbucketScope(read.actorId, membershipId),
        and: [isNull(feedbucketSubmissions.deletedAt)],
      },
      async ({ sql: where }) => {
        const rows = await this.db
          .select({
            status: feedbucketSubmissions.status,
            type: feedbucketSubmissions.type,
            cnt: count(),
          })
          .from(feedbucketSubmissions)
          .where(where)
          .groupBy(feedbucketSubmissions.status, feedbucketSubmissions.type);

        const byStatus: Record<string, number> = {};
        const byType: Record<string, number> = {};

        for (const row of rows) {
          byStatus[row.status] = (byStatus[row.status] ?? 0) + Number(row.cnt);
          byType[row.type] = (byType[row.type] ?? 0) + Number(row.cnt);
        }

        return { byStatus, byType };
      },
      () => ({ byStatus: {}, byType: {} }),
    );
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
