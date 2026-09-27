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
  inArray,
  isNull,
  like,
} from "drizzle-orm";
import {
  feedbucketAttachments,
  feedbucketSubmissions,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { registerAfterCommit } from "../../common/tenant/tenant-context";
import { StorageService } from "../storage/storage.service";
import type { ScopedRead } from "../access/scoped-read";
import { feedbucketScope } from "./feedbucket-scope";
import { buildSubmissionFilterConditions } from "./feedbucket-submission-filters";
import { bulkMutateFeedbucketSubmissions } from "./feedbucket-submissions-bulk";
import {
  type BulkSubmissionsInput,
  type ConvertToTicketInput,
  type FeedbucketMediaKind,
  type ListSubmissionsQuery,
  type UpdateSubmissionInput,
} from "./feedbucket.schemas";
import { decodeIntegerCursor, buildCursorPage } from "../../common/pagination/cursor";
import { keysetBeforeId } from "../../common/pagination/keyset";
import type { ProjectsTicketsCreateService } from "../build/core/tickets/projects-tickets-create.service";
import { resolveOrganizationActorsByUserIds } from "../../common/organization/organization-actor";
import {
  deriveFeedbackTicketTitle,
  resolveFeedbucketTicketTarget,
} from "./feedbucket-ticket-routing";
import { assertProjectAccess } from "../build/core";
import { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

interface OffsetPageMeta {
  page?: number;
  total?: number;
  totalPages?: number;
}

function offsetPageMeta(
  total: number | null,
  page: number,
  limit: number,
): OffsetPageMeta {
  if (total === null) return {};
  return { page, total, totalPages: Math.ceil(total / limit) };
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
    const { page, limit, cursor } = query;
    const position = decodeIntegerCursor(cursor);
    if (cursor !== undefined && position === null)
      throw new BadRequestException("Invalid pagination cursor");

    const domain = await buildSubmissionFilterConditions(
      this.db,
      read.orgId,
      query,
    );
    if (position)
      domain.push(
        keysetBeforeId(
          feedbucketSubmissions.createdAt,
          feedbucketSubmissions.id,
          position,
        ),
      );

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
            orderBy: [desc(feedbucketSubmissions.createdAt), desc(feedbucketSubmissions.id)],
            limit: limit + 1,
            offset: position ? 0 : (page - 1) * limit,
          }),
          position
            ? Promise.resolve(null)
            : this.db
                .select({ total: count() })
                .from(feedbucketSubmissions)
                .where(where),
        ]);

        const cursorPage = buildCursorPage(rows, limit, (row) => ({
          sortValue: row.createdAt.toISOString(),
          id: String(row.id),
        }));

        return {
          ...cursorPage,
          ...offsetPageMeta(
            countResult === null ? null : Number(countResult[0]?.total ?? 0),
            page,
            limit,
          ),
        };
      },
      () => ({
        data: [],
        pagination: { limit, hasMore: false, nextCursor: null },
        ...offsetPageMeta(position ? null : 0, page, limit),
      }),
    );
  }

  async bulkMutate(
    read: ScopedRead,
    actor: CurrentUserContext,
    body: BulkSubmissionsInput,
    membershipId: number | null,
  ) {
    return bulkMutateFeedbucketSubmissions(
      this.db,
      this.access,
      actor,
      read,
      membershipId,
      body,
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
    ticketsService: ProjectsTicketsCreateService,
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
