import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, isNull, lt } from "drizzle-orm";
import { queryTickets } from "./projects-tickets-read.query";
import {
  buildCursorPage,
  decodeCursor,
} from "../../../common/pagination/cursor";
import {
  organizationPeople,
  organizationMembers,
  ticketActivityLog,
  ticketAttachments,
  ticketLabelMappings,
  tickets,
  ticketWatchers,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ProjectsActivityService } from "./projects-activity.service";
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
} from "./dto/projects.schemas";
import { assertTicketInOrg } from "./project-access";
import { AccessService } from "../../access/access.service";
import {
  assertTicketReadAccess,
  type TicketReadAccess,
} from "./build-ticket-read-access";
import {
  resolvePersonDisplayName,
  UNRESOLVED_MEMBER_NAME,
} from "../../../common/organization/person-display-name";

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

  addComment(u: CurrentUserContext, ticketId: number, body: CommentInput) {
    return this.comments.addComment(u, ticketId, body);
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
    commentId: number,
    userId: string,
    orgId: string,
    emoji: string,
    membershipId: number | null,
    ticketId: number,
  ) {
    return this.comments.addReaction(
      commentId,
      userId,
      orgId,
      emoji,
      membershipId,
      ticketId,
    );
  }

  removeReaction(
    commentId: number,
    userId: string,
    orgId: string,
    emoji: string,
    membershipId: number | null,
    ticketId: number,
  ) {
    return this.comments.removeReaction(
      commentId,
      userId,
      orgId,
      emoji,
      membershipId,
      ticketId,
    );
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

  async getSubtasks(orgId: string, ticketId: number) {
    await assertTicketInOrg(this.db, orgId, ticketId);
    return queryTickets(
      this.db,
      and(
        eq(tickets.parentTicketId, ticketId),
        eq(tickets.orgId, orgId),
        isNull(tickets.deletedAt),
      ),
      [asc(tickets.rank), asc(tickets.id)],
      200,
    );
  }

  private async requireTicket(orgId: string, ticketId: number): Promise<void> {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, ticketId),
        eq(tickets.orgId, orgId),
        isNull(tickets.deletedAt),
      ),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
  }

  async getWatchers(orgId: string, ticketId: number) {
    await this.requireTicket(orgId, ticketId);
    const rows = await this.db.query.ticketWatchers.findMany({
      where: eq(ticketWatchers.ticketId, ticketId),
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
    ticketId: number,
    body: AddWatcherInput,
  ) {
    await this.requireTicket(u.orgId, ticketId);
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

  async removeWatcher(u: CurrentUserContext, ticketId: number) {
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
          eq(ticketWatchers.ticketId, ticketId),
          eq(ticketWatchers.membershipId, member.id),
        ),
      );
    return { success: true };
  }

  async addLabel(
    orgId: string,
    userId: string,
    ticketId: number,
    body: AddLabelInput,
  ) {
    await this.requireTicket(orgId, ticketId);
    const [mapping] = await this.db
      .insert(ticketLabelMappings)
      .values({ orgId, ticketId, labelId: body.labelId })
      .onConflictDoNothing()
      .returning({ id: ticketLabelMappings.id });
    if (mapping) await this.logLabelChange(orgId, ticketId, userId);
    return { success: true };
  }

  async removeLabel(
    orgId: string,
    userId: string,
    ticketId: number,
    labelId: number,
  ) {
    await this.requireTicket(orgId, ticketId);
    const deleted = await this.db
      .delete(ticketLabelMappings)
      .where(
        and(
          eq(ticketLabelMappings.ticketId, ticketId),
          eq(ticketLabelMappings.labelId, labelId),
        ),
      )
      .returning({ id: ticketLabelMappings.id });
    if (deleted.length > 0) await this.logLabelChange(orgId, ticketId, userId);
    return { success: true };
  }

  private async logLabelChange(
    orgId: string,
    ticketId: number,
    userId: string,
  ): Promise<void> {
    try {
      await this.activity.logTicketActivity(
        orgId,
        ticketId,
        userId,
        "label_changed",
      );
    } catch (error) {
      logger.error("Failed to log label activity", { error });
    }
  }

  async addAttachment(
    u: CurrentUserContext,
    ticketId: number,
    body: AttachmentInput,
  ) {
    await this.requireTicket(u.orgId, ticketId);
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

  getChecklists(orgId: string, projectId: number, ticketId: number) {
    return this.checklistsService.getChecklists(orgId, projectId, ticketId);
  }

  createChecklist(
    orgId: string,
    projectId: number,
    ticketId: number,
    data: { title: string },
  ) {
    return this.checklistsService.createChecklist(
      orgId,
      projectId,
      ticketId,
      data,
    );
  }

  updateChecklist(orgId: string, checklistId: number, data: { title: string }) {
    return this.checklistsService.updateChecklist(orgId, checklistId, data);
  }

  deleteChecklist(orgId: string, checklistId: number) {
    return this.checklistsService.deleteChecklist(orgId, checklistId);
  }

  createChecklistItem(
    orgId: string,
    checklistId: number,
    data: {
      text: string;
      assigneeId?: string;
      dueDate?: string | null;
      order: number;
    },
  ) {
    return this.checklistsService.createChecklistItem(orgId, checklistId, data);
  }

  updateChecklistItem(
    orgId: string,
    itemId: number,
    data: {
      text?: string;
      isCompleted?: boolean;
      assigneeId?: string | null;
      dueDate?: string | null;
      order?: number;
    },
  ) {
    return this.checklistsService.updateChecklistItem(orgId, itemId, data);
  }

  deleteChecklistItem(orgId: string, itemId: number) {
    return this.checklistsService.deleteChecklistItem(orgId, itemId);
  }

  getGitLinks(orgId: string, projectId: number, ticketId: number) {
    return this.linksService.getGitLinks(orgId, projectId, ticketId);
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
