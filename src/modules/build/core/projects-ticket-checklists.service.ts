import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  ticketChecklistItems,
  ticketChecklists,
  tickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { toChecklistItemRow } from "./projects-ticket-checklist-row";

@Injectable()
export class ProjectsTicketChecklistsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async loadChecklistRow(orgId: string, checklistId: number) {
    const [row] = await this.db
      .select({
        id: ticketChecklists.id,
        orgId: ticketChecklists.orgId,
        ticketId: ticketChecklists.ticketId,
        title: ticketChecklists.title,
        createdAt: ticketChecklists.createdAt,
        updatedAt: ticketChecklists.updatedAt,
        projectId: tickets.projectId,
      })
      .from(ticketChecklists)
      .leftJoin(tickets, eq(tickets.id, ticketChecklists.ticketId))
      .where(and(eq(ticketChecklists.id, checklistId), eq(ticketChecklists.orgId, orgId)))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      orgId: row.orgId,
      projectId: row.projectId ?? 0,
      ticketId: row.ticketId,
      title: row.title,
      position: 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async getChecklists(orgId: string, projectId: number, ticketId: number) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, ticketId),
        eq(tickets.projectId, projectId),
        eq(tickets.orgId, orgId),
        isNull(tickets.deletedAt),
      ),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const checklists = await this.db.query.ticketChecklists.findMany({
      where: and(
        eq(ticketChecklists.ticketId, ticketId),
        eq(ticketChecklists.orgId, orgId),
      ),
      with: { items: { orderBy: (i, { asc }) => [asc(i.order)] } },
      orderBy: (c, { asc }) => [asc(c.createdAt)],
      limit: 100,
    });

    return checklists.map((checklist) => ({
      id: checklist.id,
      orgId: checklist.orgId,
      projectId,
      ticketId: checklist.ticketId,
      title: checklist.title,
      position: 0,
      createdAt: checklist.createdAt,
      updatedAt: checklist.updatedAt,
      items: checklist.items.map((item) => toChecklistItemRow(item)),
    }));
  }

  async createChecklist(
    orgId: string,
    projectId: number,
    ticketId: number,
    data: { title: string },
  ) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, ticketId),
        eq(tickets.projectId, projectId),
        eq(tickets.orgId, orgId),
        isNull(tickets.deletedAt),
      ),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const [checklist] = await this.db
      .insert(ticketChecklists)
      .values({ orgId, ticketId, title: data.title })
      .returning({ id: ticketChecklists.id });
    if (!checklist) throw new NotFoundException("Checklist not found after creation");
    const loaded = await this.loadChecklistRow(orgId, checklist.id);
    if (!loaded) throw new NotFoundException("Checklist not found after creation");
    return loaded;
  }

  async updateChecklist(
    orgId: string,
    checklistId: number,
    data: { title: string },
  ) {
    const [updated] = await this.db
      .update(ticketChecklists)
      .set({ title: data.title })
      .where(
        and(
          eq(ticketChecklists.id, checklistId),
          eq(ticketChecklists.orgId, orgId),
        ),
      )
      .returning({ id: ticketChecklists.id });
    if (!updated) throw new NotFoundException("Checklist not found");
    const loaded = await this.loadChecklistRow(orgId, updated.id);
    if (!loaded) throw new NotFoundException("Checklist not found");
    return loaded;
  }

  async deleteChecklist(orgId: string, checklistId: number) {
    const [deleted] = await this.db
      .delete(ticketChecklists)
      .where(
        and(
          eq(ticketChecklists.id, checklistId),
          eq(ticketChecklists.orgId, orgId),
        ),
      )
      .returning();
    if (!deleted) throw new NotFoundException("Checklist not found");
    return { success: true };
  }

  async createChecklistItem(
    orgId: string,
    checklistId: number,
    data: {
      text: string;
      assigneeId?: string;
      dueDate?: string | null;
      order: number;
    },
  ) {
    const checklist = await this.db.query.ticketChecklists.findFirst({
      where: and(
        eq(ticketChecklists.id, checklistId),
        eq(ticketChecklists.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!checklist) throw new NotFoundException("Checklist not found");

    const [item] = await this.db
      .insert(ticketChecklistItems)
      .values({
        orgId,
        checklistId,
        text: data.text,
        assigneeId: data.assigneeId,
        dueDate: data.dueDate,
        order: data.order,
      })
      .returning();
    if (!item) throw new NotFoundException("Checklist item not found after creation");
    return toChecklistItemRow(item);
  }

  async updateChecklistItem(
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
    const existing = await this.db.query.ticketChecklistItems.findFirst({
      where: eq(ticketChecklistItems.id, itemId),
      columns: { id: true, checklistId: true },
      with: { checklist: { columns: { orgId: true } } },
    });
    if (!existing || existing.checklist.orgId !== orgId)
      throw new NotFoundException("Checklist item not found");

    const [item] = await this.db
      .update(ticketChecklistItems)
      .set(data)
      .where(and(eq(ticketChecklistItems.orgId, orgId), eq(ticketChecklistItems.id, itemId)))
      .returning();
    if (!item) throw new NotFoundException("Checklist item not found");
    return toChecklistItemRow(item);
  }

  async deleteChecklistItem(orgId: string, itemId: number) {
    const existing = await this.db.query.ticketChecklistItems.findFirst({
      where: eq(ticketChecklistItems.id, itemId),
      columns: { id: true, checklistId: true },
      with: { checklist: { columns: { orgId: true } } },
    });
    if (!existing || existing.checklist.orgId !== orgId)
      throw new NotFoundException("Checklist item not found");

    const [deleted] = await this.db
      .delete(ticketChecklistItems)
      .where(and(eq(ticketChecklistItems.orgId, orgId), eq(ticketChecklistItems.id, itemId)))
      .returning();
    if (!deleted) throw new NotFoundException("Checklist item not found");
    return { success: true };
  }
}
