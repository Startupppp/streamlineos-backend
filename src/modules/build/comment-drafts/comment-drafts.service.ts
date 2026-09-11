import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { commentDrafts } from "../../../db/schema/build/comment-drafts";
import { tickets } from "../../../db/schema/build/tasks";
import { projects } from "../../../db/schema/build/core";
import { organizationMembers, users } from "../../../db/schema/common/auth";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { UpsertCommentDraftInput } from "./dto/comment-drafts.schemas";

@Injectable()
export class CommentDraftsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private draftOwnerFilter(membershipId: number | null) {
    if (membershipId === null)
      throw new ForbiddenException("Organization membership required");
    return eq(commentDrafts.membershipId, membershipId);
  }

  async listMine(orgId: string, membershipId: number | null, _userId: string) {
    const rows = await this.db
      .select({
        id: commentDrafts.id,
        assigneeId: users.id,
        body: commentDrafts.body,
        projectKey: projects.key,
        assigneeName: users.name,
        ticketType: tickets.type,
        assigneeImage: users.image,
        ticketTitle: tickets.title,
        projectName: projects.name,
        projectId: tickets.projectId,
        ticketStatus: tickets.status,
        ticketPriority: tickets.priority,
        assigneeLastName: users.lastName,
        ticketId: commentDrafts.ticketId,
        createdAt: commentDrafts.createdAt,
        updatedAt: commentDrafts.updatedAt,
        ticketNumber: tickets.ticketNumber,
        assigneeFirstName: users.firstName,
      })
      .from(commentDrafts)
      .innerJoin(tickets, eq(tickets.id, commentDrafts.ticketId))
      .leftJoin(
        projects,
        and(eq(projects.id, tickets.projectId), eq(projects.orgId, orgId)),
      )
      .leftJoin(organizationMembers, and(eq(organizationMembers.orgId, tickets.orgId), eq(organizationMembers.id, tickets.assigneeMembershipId)))
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(commentDrafts.orgId, orgId),
          this.draftOwnerFilter(membershipId),
          isNull(tickets.deletedAt),
        ),
      )
      .orderBy(commentDrafts.updatedAt)
      .limit(100);

    return rows.map((r) => ({
      id: r.id,
      ticketId: r.ticketId,
      body: r.body,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ticket: {
        id: r.ticketId,
        type: r.ticketType,
        title: r.ticketTitle,
        projectId: r.projectId,
        status: r.ticketStatus,
        ticketNumber: r.ticketNumber,
        projectKey: r.projectKey ?? null,
        priority: r.ticketPriority ?? null,
        projectName: r.projectName ?? null,
        assignee: r.assigneeId
          ? {
              id: r.assigneeId,
              name: r.assigneeName ?? null,
              image: r.assigneeImage ?? null,
              lastName: r.assigneeLastName ?? null,
              firstName: r.assigneeFirstName ?? null,
            }
          : null,
      },
    }));
  }

  async upsert(
    orgId: string,
    membershipId: number | null,
    userId: string,
    ticketId: number,
    input: UpsertCommentDraftInput,
  ) {
    const [ticket] = await this.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.id, ticketId),
          eq(tickets.orgId, orgId),
          isNull(tickets.deletedAt),
        ),
      )
      .limit(1);

    if (!ticket) throw new NotFoundException("Ticket not found");

    if (membershipId === null)
      throw new ForbiddenException("Organization membership required");
    const [row] = await this.db
      .insert(commentDrafts)
      .values({ orgId, membershipId, ticketId, body: input.body })
      .onConflictDoUpdate({
        target: [
          commentDrafts.orgId,
          commentDrafts.membershipId,
          commentDrafts.ticketId,
        ],
        set: { body: input.body, membershipId, updatedAt: new Date() },
      })
      .returning();

    return row;
  }

  async deleteOne(
    orgId: string,
    membershipId: number | null,
    _userId: string,
    id: number,
  ) {
    const [draft] = await this.db
      .select({ id: commentDrafts.id })
      .from(commentDrafts)
      .where(
        and(
          eq(commentDrafts.id, id),
          eq(commentDrafts.orgId, orgId),
          this.draftOwnerFilter(membershipId),
        ),
      )
      .limit(1);

    if (!draft) throw new NotFoundException("Draft not found");

    await this.db
      .delete(commentDrafts)
      .where(
        and(
          eq(commentDrafts.id, id),
          eq(commentDrafts.orgId, orgId),
          this.draftOwnerFilter(membershipId),
        ),
      );

    return { deleted: true };
  }

  async deleteByTicket(
    orgId: string,
    membershipId: number | null,
    _userId: string,
    ticketId: number,
  ) {
    await this.db
      .delete(commentDrafts)
      .where(
        and(
          eq(commentDrafts.orgId, orgId),
          this.draftOwnerFilter(membershipId),
          eq(commentDrafts.ticketId, ticketId),
        ),
      );
    return { deleted: true };
  }

  async deleteAllMine(
    orgId: string,
    membershipId: number | null,
    _userId: string,
  ) {
    await this.db
      .delete(commentDrafts)
      .where(
        and(
          eq(commentDrafts.orgId, orgId),
          this.draftOwnerFilter(membershipId),
        ),
      );
    return { deleted: true };
  }
}
