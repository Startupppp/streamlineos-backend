import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  meetingActionItems,
  projectMeetings,
  tickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CreateActionItemInput, UpdateActionItemInput } from "./dto/meetings.schemas";
import { BuildTicketCreationService } from "../core/tickets";
import { assertProjectAccess } from "../core";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

type ActionItemPatch = Partial<
  Pick<
    typeof meetingActionItems.$inferInsert,
    "title" | "description" | "assigneeId" | "dueDate" | "status"
  >
>;

@Injectable()
export class ActionItemsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly ticketCreation: BuildTicketCreationService,
    private readonly access: AccessService,
  ) {}

  private async assertMeetingAccess(actor: CurrentUserContext, projectId: number, meetingId: number): Promise<void> {
    await assertProjectAccess(this.db, this.access, actor, projectId);
    const orgId = actor.orgId;
    const m = await this.db.query.projectMeetings.findFirst({
      where: and(
        eq(projectMeetings.id, meetingId),
        eq(projectMeetings.orgId, orgId),
        eq(projectMeetings.projectId, projectId),
        isNull(projectMeetings.deletedAt),
      ),
      columns: { id: true },
    });
    if (!m) throw new NotFoundException("Meeting not found");
  }

  private async loadItem(orgId: string, meetingId: number, itemId: number) {
    const row = await this.db.query.meetingActionItems.findFirst({
      where: and(
        eq(meetingActionItems.id, itemId),
        eq(meetingActionItems.orgId, orgId),
        eq(meetingActionItems.meetingId, meetingId),
        isNull(meetingActionItems.deletedAt),
      ),
    });
    if (!row) throw new NotFoundException("Action item not found");
    return row;
  }

  async createItem(
    actor: CurrentUserContext,
    projectId: number,
    meetingId: number,
    input: CreateActionItemInput,
  ) {
    await this.assertMeetingAccess(actor, projectId, meetingId);
    const { orgId, userId } = actor;
    const [item] = await this.db
      .insert(meetingActionItems)
      .values({
        orgId,
        meetingId,
        projectId,
        title: input.title,
        description: input.description ?? null,
        assigneeId: input.assigneeId ?? null,
        dueDate: input.dueDate ? input.dueDate.toISOString().slice(0, 10) : null,
        createdBy: userId,
      })
      .returning();
    if (!item) throw new NotFoundException("Failed to create action item");
    this.audit.log({
      action: "action_item.created",
      userId,
      orgId,
      resourceType: "meeting_action_item",
      resourceId: String(item.id),
      metadata: { projectId, meetingId, itemId: item.id, title: item.title },
    });
    return item;
  }

  async updateItem(
    actor: CurrentUserContext,
    projectId: number,
    meetingId: number,
    itemId: number,
    input: UpdateActionItemInput,
  ) {
    await this.assertMeetingAccess(actor, projectId, meetingId);
    const { orgId, userId } = actor;
    await this.loadItem(orgId, meetingId, itemId);
    const patch: ActionItemPatch = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description ?? null;
    if (input.assigneeId !== undefined) patch.assigneeId = input.assigneeId ?? null;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate ? input.dueDate.toISOString().slice(0, 10) : null;
    if (input.status !== undefined) patch.status = input.status;
    const [updated] = await this.db
      .update(meetingActionItems)
      .set(patch)
      .where(and(eq(meetingActionItems.id, itemId), eq(meetingActionItems.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Action item not found");
    this.audit.log({
      action: "action_item.updated",
      userId,
      orgId,
      resourceType: "meeting_action_item",
      resourceId: String(itemId),
      metadata: { projectId, meetingId, itemId },
    });
    return updated;
  }

  async deleteItem(actor: CurrentUserContext, projectId: number, meetingId: number, itemId: number) {
    await this.assertMeetingAccess(actor, projectId, meetingId);
    const { orgId, userId } = actor;
    await this.loadItem(orgId, meetingId, itemId);
    await this.db
      .update(meetingActionItems)
      .set({ deletedAt: new Date() })
      .where(and(eq(meetingActionItems.id, itemId), eq(meetingActionItems.orgId, orgId)));
    this.audit.log({
      action: "action_item.deleted",
      userId,
      orgId,
      resourceType: "meeting_action_item",
      resourceId: String(itemId),
      metadata: { projectId, meetingId, itemId },
    });
  }

  async convertToTask(actor: CurrentUserContext, projectId: number, meetingId: number, itemId: number) {
    await assertProjectAccess(this.db, this.access, actor, projectId);
    if (!(await this.access.holds(actor, "build:tickets:create")))
      throw new ForbiddenException("Not authorized to create tickets");
    const { orgId, userId } = actor;
    const { result, createdResult } = await this.db.transaction(async (tx) => {
      const meeting = await tx.query.projectMeetings.findFirst({
        where: and(
          eq(projectMeetings.id, meetingId),
          eq(projectMeetings.orgId, orgId),
          eq(projectMeetings.projectId, projectId),
          isNull(projectMeetings.deletedAt),
        ),
        columns: { id: true },
      });
      if (!meeting) throw new NotFoundException("Meeting not found");

      const item = await tx.query.meetingActionItems.findFirst({
        where: and(
          eq(meetingActionItems.id, itemId),
          eq(meetingActionItems.orgId, orgId),
          eq(meetingActionItems.meetingId, meetingId),
          isNull(meetingActionItems.deletedAt),
        ),
      });
      if (!item) throw new NotFoundException("Action item not found");
      if (item.convertedTicketId !== null) throw new ConflictException("Action item already converted to a task");

      const createdResult = await this.ticketCreation.createInTransaction(tx, {
        orgId,
        projectId,
        actor: { userId, membershipId: null },
        drafts: [{
          title: item.title,
          description: item.description ?? null,
          type: "TASK",
          status: "TODO",
          priority: "MEDIUM",
          reporterId: userId,
          dueDate: item.dueDate ?? null,
        }],
      });
      const ticket = createdResult.tickets[0];
      if (!ticket) throw new NotFoundException("Failed to create ticket");

      const [updatedItem] = await tx
        .update(meetingActionItems)
        .set({ convertedTicketId: ticket.id, status: "converted" })
        .where(
          and(
            eq(meetingActionItems.id, itemId),
            eq(meetingActionItems.orgId, orgId),
            isNull(meetingActionItems.convertedTicketId),
          ),
        )
        .returning();

      if (!updatedItem) throw new ConflictException("Action item was already converted by a concurrent request");
      return { result: { actionItem: updatedItem, ticketId: ticket.id }, createdResult };
    });
    this.ticketCreation.publish(createdResult);

    this.audit.log({
      action: "action_item.converted",
      userId,
      orgId,
      resourceType: "meeting_action_item",
      resourceId: String(itemId),
      metadata: { projectId, meetingId, itemId, ticketId: result.ticketId },
    });
    return result;
  }
}
