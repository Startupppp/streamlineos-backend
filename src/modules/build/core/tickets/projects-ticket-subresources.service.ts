import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, isNull, lt } from "drizzle-orm";
import { queryTickets } from "./projects-tickets-read.query";
import {
  buildCursorPage,
  decodeCursor,
} from "../../../../common/pagination/cursor";
import {
  organizationPeople,
  organizationMembers,
  ticketActivityLog,
  ticketAttachments,
  ticketLabelMappings,
  tickets,
  ticketWatchers,
  users,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { logger } from "../../../../common/logger/logger.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { withSavepoint } from "../../../data-quality/savepoint";
import { ProjectsActivityService } from "../activity/projects-activity.service";
import { ProjectsTicketCommentsService } from "./projects-ticket-comments.service";
import { ProjectsTicketChecklistsService } from "./projects-ticket-checklists.service";
import { ProjectsTicketLinksService } from "./projects-ticket-links.service";
import { ProjectsTicketRelationsService } from "./projects-ticket-relations.service";
import type {
  AddLabelInput,
  AddRelatedLinkInput,
  AddRelationInput,
  AddWatcherInput,
  AttachmentInput,
  CommentInput,
  UpdateRelatedLinkInput,
} from "../dto/projects.schemas";
import { AccessService } from "../../../access/access.service";
import {
  assertTicketReadAccess,
  type TicketReadAccess,
} from "./build-ticket-read-access";
import {
  resolvePersonDisplayName,
  UNRESOLVED_MEMBER_NAME,
} from "../../../../common/organization/person-display-name";

const ACTION_LABELS: Record<string, string> = {
  created: "created this ticket",
  status_changed: "changed status",
  priority_changed: "changed priority",
  assignee_changed: "changed assignee",
  title_changed: "renamed the ticket",
  sprint_changed: "changed sprint",
  due_date_changed: "changed due date",
  comment_added: "added a comment",
  comment_updated: "edited a comment",
  comment_deleted: "deleted a comment",
  label_changed: "changed labels",
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, " ");
}

@Injectable()
export class ProjectsTicketSubresourcesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly activity: ProjectsActivityService,
    private readonly comments: ProjectsTicketCommentsService,
    private readonly checklistsService: ProjectsTicketChecklistsService,
    private readonly linksService: ProjectsTicketLinksService,
    private readonly relationsService: ProjectsTicketRelationsService,
    @Inject(AccessService) private readonly access: TicketReadAccess,
  ) {}

  addComment(
    u: CurrentUserContext,
    projectId: number | null,
    ticketId: number,
    body: CommentInput,
  ) {
    return this.comments.addComment(u, projectId, ticketId, body);
  }

  getComment(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    commentId: number,
  ) {
    return this.comments.getComment(u, projectId, ticketId, commentId);
  }

  editComment(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    commentId: number,
    content: string,
  ) {
    return this.comments.editComment(
      u,
      projectId,
      ticketId,
      commentId,
      content,
    );
  }

  deleteComment(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    commentId: number,
  ) {
    return this.comments.deleteComment(u, projectId, ticketId, commentId);
  }

  addReaction(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    commentId: number,
    emoji: string,
  ) {
    return this.comments.addReaction(u, projectId, ticketId, commentId, emoji);
  }

  removeReaction(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    commentId: number,
    emoji: string,
  ) {
    return this.comments.removeReaction(u, projectId, ticketId, commentId, emoji);
  }

  getCommentReactions(commentId: number, orgId: string) {
    return this.comments.getCommentReactions(commentId, orgId);
  }

  async getActivity(
    actor: CurrentUserContext,
    projectId: number,
    ticketId: number,
    opts: { limit: number; cursor?: string },
  ) {
    await assertTicketReadAccess(
      this.db,
      this.access,
      actor,
      projectId,
      ticketId,
    );
    const orgId = actor.orgId;

    const position = decodeCursor(opts.cursor);
    const rawId = position !== null ? Number(position.sortValue) : NaN;
    const beforeId = isNaN(rawId) ? undefined : rawId;

    const conditions = [
      eq(ticketActivityLog.ticketId, ticketId),
      eq(ticketActivityLog.orgId, orgId),
    ];
    if (beforeId !== undefined)
      conditions.push(lt(ticketActivityLog.id, beforeId));

    const rows = await this.db
      .select({
        id: ticketActivityLog.id,
        action: ticketActivityLog.action,
        fromValue: ticketActivityLog.fromValue,
        toValue: ticketActivityLog.toValue,
        createdAt: ticketActivityLog.createdAt,
        userMembershipId: ticketActivityLog.userMembershipId,
        personUserId: organizationPeople.userId,
        memberUserId: organizationMembers.userId,
        displayName: organizationPeople.displayName,
        firstName: organizationPeople.firstName,
        lastName: organizationPeople.lastName,
        avatarUrl: organizationPeople.avatarUrl,
        accountName: users.name,
        email: users.email,
        userImage: users.image,
      })
      .from(ticketActivityLog)
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, ticketActivityLog.orgId),
          eq(organizationMembers.id, ticketActivityLog.userMembershipId),
        ),
      )
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(
        organizationPeople,
        and(
          eq(organizationPeople.organizationId, ticketActivityLog.orgId),
          isNull(organizationPeople.deletedAt),
          eq(organizationPeople.userId, organizationMembers.userId),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(ticketActivityLog.id))
      .limit(opts.limit + 1);

    const mapped = rows.map((row) => ({
      id: row.id,
      action: row.action,
      label: actionLabel(row.action),
      fromValue: row.fromValue,
      toValue: row.toValue,
      createdAt: row.createdAt,
      user:
        row.userMembershipId !== null && row.userMembershipId !== undefined
          ? {
              id: row.personUserId ?? row.memberUserId ?? null,
              name: resolvePersonDisplayName(row) ?? UNRESOLVED_MEMBER_NAME,
              image: row.avatarUrl ?? row.userImage ?? null,
            }
          : null,
    }));

    return buildCursorPage(mapped, opts.limit, (r) => ({
      sortValue: String(r.id),
      id: String(r.id),
    }));
  }

  async getSubtasks(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    return queryTickets(
      this.db,
      and(
        eq(tickets.parentTicketId, ticketId),
        eq(tickets.projectId, projectId),
        eq(tickets.orgId, u.orgId),
        isNull(tickets.deletedAt),
      ),
      [asc(tickets.rank), asc(tickets.id)],
      200,
    );
  }

  async getWatchers(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    const rows = await this.db.query.ticketWatchers.findMany({
      where: and(
        eq(ticketWatchers.ticketId, ticketId),
        eq(ticketWatchers.orgId, u.orgId),
      ),
      columns: { id: true, ticketId: true, createdAt: true },
      with: {
        user: {
          columns: { userId: true },
          with: {
            user: {
              columns: {
                id: true,
                name: true,
                firstName: true,
                lastName: true,
                image: true,
                email: true,
              },
            },
          },
        },
      },
      limit: 100,
    });
    return rows.map(({ user: membership, ...watcher }) => ({
      ...watcher,
      userId: membership?.userId ?? null,
      user: membership?.user ?? null,
    }));
  }

  async addWatcher(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    body: AddWatcherInput,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    const userId = body.userId ?? u.userId;
    const [member] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, u.orgId),
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .limit(1);
    if (!member)
      throw new NotFoundException("Watcher is not an organization member");
    await this.db
      .insert(ticketWatchers)
      .values({ orgId: u.orgId, ticketId, membershipId: member.id })
      .onConflictDoNothing();
    const [person] = await this.db
      .select({
        displayName: organizationPeople.displayName,
        firstName: organizationPeople.firstName,
        lastName: organizationPeople.lastName,
        image: organizationPeople.avatarUrl,
      })
      .from(organizationPeople)
      .where(
        and(
          eq(organizationPeople.userId, userId),
          eq(organizationPeople.organizationId, u.orgId),
        ),
      )
      .limit(1);
    const name = resolvePersonDisplayName(person ?? {});
    return {
      userId,
      name,
      image: person?.image ?? null,
      membershipId: member.id,
    };
  }

  async removeWatcher(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    const [member] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, u.orgId),
          eq(organizationMembers.userId, u.userId),
        ),
      )
      .limit(1);
    if (!member) return { success: true };
    await this.db
      .delete(ticketWatchers)
      .where(
        and(
          eq(ticketWatchers.orgId, u.orgId),
          eq(ticketWatchers.ticketId, ticketId),
          eq(ticketWatchers.membershipId, member.id),
        ),
      );
    return { success: true };
  }

  async addLabel(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    body: AddLabelInput,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    const [mapping] = await this.db
      .insert(ticketLabelMappings)
      .values({ orgId: u.orgId, ticketId, labelId: body.labelId })
      .onConflictDoNothing()
      .returning({ id: ticketLabelMappings.id });
    if (mapping)
      await this.logLabelChange(u.orgId, ticketId, u.userId);
    return { success: true };
  }

  async removeLabel(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    labelId: number,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    const deleted = await this.db
      .delete(ticketLabelMappings)
      .where(
        and(
          eq(ticketLabelMappings.ticketId, ticketId),
          eq(ticketLabelMappings.labelId, labelId),
          eq(ticketLabelMappings.orgId, u.orgId),
        ),
      )
      .returning({ id: ticketLabelMappings.id });
    if (deleted.length > 0)
      await this.logLabelChange(u.orgId, ticketId, u.userId);
    return { success: true };
  }

  private async logLabelChange(
    orgId: string,
    ticketId: number,
    userId: string,
  ): Promise<void> {
    try {
      await withSavepoint(() => this.activity.logTicketActivity(
        orgId,
        ticketId,
        userId,
        "label_changed",
      ));
    } catch (error) {
      logger.error("Failed to log label activity", { error });
    }
  }

  async addAttachment(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    body: AttachmentInput,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    const [attachment] = await this.db
      .insert(ticketAttachments)
      .values({
        orgId: u.orgId,
        ticketId,
        fileUrl: body.fileUrl,
        fileName: body.fileName,
        fileSize: body.fileSize,
        mimeType: body.mimeType,
        uploadedBy: u.userId,
      })
      .returning();
    return { id: attachment.id };
  }

  listRelations(u: CurrentUserContext, projectId: number, ticketId: number) {
    return this.relationsService.listRelations(u, projectId, ticketId);
  }

  addRelation(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    body: AddRelationInput,
  ) {
    return this.relationsService.addRelation(u, projectId, ticketId, body);
  }

  removeRelation(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    relatedId: number,
  ) {
    return this.relationsService.removeRelation(
      u,
      projectId,
      ticketId,
      relatedId,
    );
  }

  async getChecklists(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    return this.checklistsService.getChecklists(u.orgId, projectId, ticketId);
  }

  async createChecklist(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    data: { title: string },
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    return this.checklistsService.createChecklist(
      u.orgId,
      projectId,
      ticketId,
      data,
    );
  }

  async updateChecklist(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    checklistId: number,
    data: { title: string },
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    return this.checklistsService.updateChecklist(
      u.orgId,
      projectId,
      ticketId,
      checklistId,
      data,
    );
  }

  async deleteChecklist(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    checklistId: number,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    return this.checklistsService.deleteChecklist(
      u.orgId,
      projectId,
      ticketId,
      checklistId,
    );
  }

  async createChecklistItem(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    checklistId: number,
    data: {
      text: string;
      assigneeId?: string;
      dueDate?: string | null;
      order: number;
    },
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    return this.checklistsService.createChecklistItem(
      u.orgId,
      projectId,
      ticketId,
      checklistId,
      data,
    );
  }

  async updateChecklistItem(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    checklistId: number,
    itemId: number,
    data: {
      text?: string;
      isCompleted?: boolean;
      assigneeId?: string | null;
      dueDate?: string | null;
      order?: number;
    },
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    return this.checklistsService.updateChecklistItem(
      u.orgId,
      projectId,
      ticketId,
      checklistId,
      itemId,
      data,
    );
  }

  async deleteChecklistItem(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    checklistId: number,
    itemId: number,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    return this.checklistsService.deleteChecklistItem(
      u.orgId,
      projectId,
      ticketId,
      checklistId,
      itemId,
    );
  }

  async getGitLinks(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    return this.linksService.getGitLinks(u.orgId, projectId, ticketId);
  }

  listRelatedLinks(u: CurrentUserContext, projectId: number, ticketId: number) {
    return this.linksService.listRelatedLinks(u, projectId, ticketId);
  }

  addRelatedLink(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    body: AddRelatedLinkInput,
  ) {
    return this.linksService.addRelatedLink(u, projectId, ticketId, body);
  }

  updateRelatedLink(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    linkId: number,
    body: UpdateRelatedLinkInput,
  ) {
    return this.linksService.updateRelatedLink(
      u,
      projectId,
      ticketId,
      linkId,
      body,
    );
  }

  deleteRelatedLink(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    linkId: number,
  ) {
    return this.linksService.deleteRelatedLink(u, projectId, ticketId, linkId);
  }
}
