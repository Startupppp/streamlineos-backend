import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  meetingActionItems,
  projectMeetings,
  tickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CreateActionItemInput, UpdateActionItemInput } from "./dto/meetings.schemas";

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
  ) {}

  private async assertMeeting(orgId: string, projectId: number, meetingId: number): Promise<void> {
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
    orgId: string,
    userId: string,
    projectId: number,
    meetingId: number,
    input: CreateActionItemInput,
  ) {
    await this.assertMeeting(orgId, projectId, meetingId);
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
    orgId: string,
    userId: string,
    projectId: number,
    meetingId: number,
    itemId: number,
    input: UpdateActionItemInput,
  ) {
    await this.assertMeeting(orgId, projectId, meetingId);
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

  async deleteItem(orgId: string, userId: string, projectId: number, meetingId: number, itemId: number) {
    await this.assertMeeting(orgId, projectId, meetingId);
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

  async convertToTask(orgId: string, userId: string, projectId: number, meetingId: number, itemId: number) {
    const result = await this.db.transaction(async (tx) => {
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

      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${tickets.ticketNumber}), 0)` })
        .from(tickets)
        .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)));
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;

      const [ticket] = await tx
        .insert(tickets)
        .values({
          orgId,
          projectId,
          ticketNumber: nextNumber,
          title: item.title,
          description: item.description ?? null,
          type: "TASK",
          status: "TODO",
          priority: "MEDIUM",
          reporterId: userId,
          assigneeId: item.assigneeId ?? null,
          dueDate: item.dueDate ?? null,
        })
        .returning();
      if (!ticket) throw new NotFoundException("Failed to create ticket");

      const [updatedItem] = await tx
        .update(meetingActionItems)
        .set({ convertedTicketId: ticket.id, status: "converted" })
        .where(and(eq(meetingActionItems.id, itemId), eq(meetingActionItems.orgId, orgId)))
        .returning();

      return { actionItem: updatedItem, ticketId: ticket.id };
    });

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
