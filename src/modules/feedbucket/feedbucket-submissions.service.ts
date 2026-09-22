import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  feedbucketAttachments,
  feedbucketSubmissions,
  feedbucketWidgets,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { StorageService } from "../storage/storage.service";
import type { ScopedRead } from "../access/scoped-read";
import { feedbucketScope } from "./feedbucket-scope";
import {
  type ConvertToTicketInput,
  type FeedbucketMediaKind,
  type ListSubmissionsQuery,
  type UpdateSubmissionInput,
} from "./feedbucket.schemas";
import type { ProjectsTicketsService } from "../build/core/projects-tickets.service";
import { resolveOrganizationActorsByUserIds } from "../../common/organization/organization-actor";
import {
  deriveFeedbackTicketTitle,
  resolveFeedbucketTicketTarget,
} from "./feedbucket-ticket-routing";
import { assertProjectAccess } from "../build/core/project-access";
import { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

function submissionsInWidgetsMatching(condition: SQL | undefined): SQL {
  return sql`${feedbucketSubmissions.widgetId} IN (SELECT ${feedbucketWidgets.id} FROM ${feedbucketWidgets} WHERE ${condition})`;
}

function submissionsInManagedProductCondition(
  orgId: string,
  managedProductId: number,
): SQL {
  return submissionsInWidgetsMatching(
    and(
      eq(feedbucketWidgets.orgId, orgId),
      eq(feedbucketWidgets.managedProductId, managedProductId),
      isNull(feedbucketWidgets.deletedAt),
    ),
  );
}

const FEEDBUCKET_MEDIA_MIME_PREFIX: Record<FeedbucketMediaKind, string> = {
  screenshot: "image/%",
  recording: "video/%",
};

export type FeedbucketMediaStorage = Pick<
  StorageService,
  "deleteFileIfPresent"
>;

@Injectable()
export class FeedbucketSubmissionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(StorageService) private readonly storage: FeedbucketMediaStorage,
    private readonly access: AccessService,
  ) {}

  async list(
    read: ScopedRead,
    query: ListSubmissionsQuery,
    membershipId: number | null,
  ) {
    const orgId = read.orgId;
    const {
      page,
      limit,
      widgetId,
      managedProductId,
      type,
      status,
      assigneeId,
      search,
      linked,
      from,
      to,
    } = query;
    const offset = (page - 1) * limit;

    const domain = [
      widgetId !== undefined
        ? eq(feedbucketSubmissions.widgetId, widgetId)
        : undefined,
      managedProductId !== undefined
        ? submissionsInManagedProductCondition(orgId, managedProductId)
        : undefined,
      type !== undefined ? eq(feedbucketSubmissions.type, type) : undefined,
      status !== undefined
        ? eq(feedbucketSubmissions.status, status)
        : undefined,
      isNull(feedbucketSubmissions.deletedAt),
    ];
    if (assigneeId !== undefined) {
      const membership = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, assigneeId),
        ),
        columns: { id: true },
      });
      domain.push(
        eq(feedbucketSubmissions.assigneeMembershipId, membership?.id ?? -1),
      );
    }
    if (search?.trim()) {
      domain.push(ilike(feedbucketSubmissions.message, `%${search}%`));
    }
    if (linked === "linked") {
      domain.push(isNotNull(feedbucketSubmissions.linkedTicketId));
    } else if (linked === "unlinked") {
      domain.push(isNull(feedbucketSubmissions.linkedTicketId));
    }
    if (from !== undefined) {
      domain.push(gte(feedbucketSubmissions.createdAt, new Date(from)));
    }
    if (to !== undefined) {
      domain.push(lt(feedbucketSubmissions.createdAt, new Date(to)));
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
          this.db
            .select({ total: count() })
            .from(feedbucketSubmissions)
            .where(where),
        ]);

        const total = Number(countResult[0]?.total ?? 0);
        return {
          data: rows,
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        };
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

  async update(
    orgId: string,
    submissionId: number,
    dto: UpdateSubmissionInput,
  ) {
    await this.findOne(orgId, submissionId);
    const patch: Partial<typeof feedbucketSubmissions.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.priority !== undefined) patch.priority = dto.priority;
    if (dto.assigneeId !== undefined) {
      const membership =
        dto.assigneeId === null
          ? null
          : await this.db.query.organizationMembers.findFirst({
              where: and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.userId, dto.assigneeId),
              ),
              columns: { id: true },
            });
      patch.assigneeMembershipId = membership?.id ?? null;
    }

    const [updated] = await this.db
      .update(feedbucketSubmissions)
      .set(patch)
      .where(
        and(
          eq(feedbucketSubmissions.id, submissionId),
          eq(feedbucketSubmissions.orgId, orgId),
        ),
      )
      .returning();
    return updated;
  }

  async softDelete(orgId: string, submissionId: number) {
    await this.findOne(orgId, submissionId);
    await this.db
      .update(feedbucketSubmissions)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(feedbucketSubmissions.id, submissionId),
          eq(feedbucketSubmissions.orgId, orgId),
        ),
      );
  }

  async deleteMedia(
    orgId: string,
    submissionId: number,
    mediaKind: FeedbucketMediaKind,
  ) {
    const submission = await this.findOne(orgId, submissionId);

    const attachments = await this.db
      .select({
        id: feedbucketAttachments.id,
        fileUrl: feedbucketAttachments.fileUrl,
        fileKey: feedbucketAttachments.fileKey,
      })
      .from(feedbucketAttachments)
      .where(
        and(
          eq(feedbucketAttachments.submissionId, submissionId),
          eq(feedbucketAttachments.orgId, orgId),
          like(
            feedbucketAttachments.mimeType,
            FEEDBUCKET_MEDIA_MIME_PREFIX[mediaKind],
          ),
        ),
      );

    const keys = new Set<string>();
    for (const attachment of attachments) {
      if (attachment.fileKey) keys.add(attachment.fileKey);
      else if (attachment.fileUrl) keys.add(attachment.fileUrl);
    }
    if (mediaKind === "screenshot") {
      if (submission.screenshotKey) keys.add(submission.screenshotKey);
      else if (submission.screenshotUrl) keys.add(submission.screenshotUrl);
    }

    if (keys.size === 0 && attachments.length === 0)
      throw new NotFoundException(
        mediaKind === "recording"
          ? "Submission has no recording"
          : "Submission has no screenshot",
      );

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        if (attachments.length > 0)
          await tx.delete(feedbucketAttachments).where(
            and(
              eq(feedbucketAttachments.orgId, orgId),
              inArray(
                feedbucketAttachments.id,
                attachments.map((attachment) => attachment.id),
              ),
            ),
          );

        if (mediaKind === "screenshot")
          await tx
            .update(feedbucketSubmissions)
            .set({
              screenshotUrl: null,
              screenshotKey: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(feedbucketSubmissions.id, submissionId),
                eq(feedbucketSubmissions.orgId, orgId),
              ),
            );

        const purge = async (): Promise<void> => {
          for (const key of keys)
            await this.storage.deleteFileIfPresent(orgId, key);
        };
        if (!registerAfterCommit(purge)) await purge();
      },
      { orgId },
    );
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
    u: CurrentUserContext,
    submissionId: number,
    ticketsService: ProjectsTicketsService,
    override?: ConvertToTicketInput,
  ) {
    const orgId = u.orgId;
    const submission = await this.findOne(orgId, submissionId);
    const widget = submission.widget;
    if (!widget)
      throw new NotFoundException("Submission has no associated widget");

    const assigneeMembershipId = await this.resolveOverrideAssignee(
      orgId,
      override?.assigneeId,
    );
    const { projectId, assigneeMembershipId: resolvedAssignee } =
      resolveFeedbucketTicketTarget(widget, submission.type, {
        projectId: override?.projectId,
        assigneeMembershipId: assigneeMembershipId ?? undefined,
      });
    if (!projectId) throw new NotFoundException("Widget has no project linked");
    await assertProjectAccess(this.db, this.access, u, projectId);

    const ticket = await ticketsService.createFromFeedback(
      orgId,
      u.userId,
      projectId,
      {
        title: deriveFeedbackTicketTitle(submission.message, submission.type),
        description: `**Feedback type:** ${submission.type}\n\n${submission.message}`,
        type: widget.defaultTicketType,
        assigneeMembershipId: resolvedAssignee,
      },
    );

    await this.db
      .update(feedbucketSubmissions)
      .set({ linkedTicketId: ticket.id, updatedAt: new Date() })
      .where(
        and(
          eq(feedbucketSubmissions.id, submissionId),
          eq(feedbucketSubmissions.orgId, orgId),
        ),
      );

    return { ticketId: ticket.id };
  }

  private async resolveOverrideAssignee(
    orgId: string,
    assigneeId: string | undefined,
  ): Promise<number | null> {
    if (!assigneeId) return null;
    const actorMap = await resolveOrganizationActorsByUserIds(this.db, orgId, [
      assigneeId,
    ]);
    const actor = actorMap.get(assigneeId);
    if (!actor)
      throw new BadRequestException(
        `${assigneeId} is not an active member of this organization`,
      );
    return actor.membershipId;
  }
}
