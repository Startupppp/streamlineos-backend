import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  ticketChecklistItems,
  ticketChecklists,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { AccessService } from "../../../access/access.service";
import {
  assertTicketReadAccess,
  type TicketReadAccess,
} from "./build-ticket-read-access";

const CHECKLIST_ITEM_LIMIT = 200;

export function toChecklistItemRow(item: typeof ticketChecklistItems.$inferSelect) {
  return {
    id: item.id,
    orgId: item.orgId,
    checklistId: item.checklistId,
    text: item.text,
    isCompleted: item.isCompleted,
    assigneeId: item.assigneeId,
    dueDate: item.dueDate,
    order: item.order,
    createdAt: item.createdAt,
  };
}

@Injectable()
export class ProjectsTicketChecklistsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(AccessService) private readonly access: TicketReadAccess,
  ) {}

  private async loadChecklistRow(orgId: string, checklistId: number) {
    const [row] = await this.db
      .select({
        id: ticketChecklists.id,
        orgId: ticketChecklists.orgId,
        ticketId: ticketChecklists.ticketId,
        title: ticketChecklists.title,
        createdAt: ticketChecklists.createdAt,
        updatedAt: ticketChecklists.updatedAt,
      })
      .from(ticketChecklists)
      .where(and(eq(ticketChecklists.id, checklistId), eq(ticketChecklists.orgId, orgId)))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      orgId: row.orgId,
      ticketId: row.ticketId,
      title: row.title,
      position: 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async requireTicketAccess(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
  ): Promise<void> {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
  }

  private async requireChecklistInTicket(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    checklistId: number,
  ): Promise<void> {
    await this.requireTicketAccess(u, projectId, ticketId);
    const checklist = await this.db.query.ticketChecklists.findFirst({
      where: and(
        eq(ticketChecklists.id, checklistId),
        eq(ticketChecklists.ticketId, ticketId),
        eq(ticketChecklists.orgId, u.orgId),
      ),
      columns: { id: true },
    });
    if (!checklist) throw new NotFoundException("Checklist not found");
  }

  async getChecklists(u: CurrentUserContext, projectId: number, ticketId: number) {
    await this.requireTicketAccess(u, projectId, ticketId);

    const checklists = await this.db.query.ticketChecklists.findMany({
      where: and(
        eq(ticketChecklists.ticketId, ticketId),
        eq(ticketChecklists.orgId, u.orgId),
      ),
      with: {
        items: {
          orderBy: (i, { asc }) => [asc(i.order)],
          limit: CHECKLIST_ITEM_LIMIT,
        },
      },
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
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    data: { title: string },
  ) {
    await this.requireTicketAccess(u, projectId, ticketId);

    const [checklist] = await this.db
      .insert(ticketChecklists)
      .values({ orgId: u.orgId, ticketId, title: data.title })
      .returning({ id: ticketChecklists.id });
    if (!checklist) throw new NotFoundException("Checklist not found after creation");
    const loaded = await this.loadChecklistRow(u.orgId, checklist.id);
    if (!loaded) throw new NotFoundException("Checklist not found after creation");
    return { ...loaded, projectId };
  }

  async updateChecklist(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    checklistId: number,
    data: { title: string },
  ) {
    await this.requireChecklistInTicket(u, projectId, ticketId, checklistId);
    const [updated] = await this.db
      .update(ticketChecklists)
      .set({ title: data.title })
      .where(
        and(
          eq(ticketChecklists.id, checklistId),
          eq(ticketChecklists.ticketId, ticketId),
          eq(ticketChecklists.orgId, u.orgId),
        ),
      )
      .returning({ id: ticketChecklists.id });
    if (!updated) throw new NotFoundException("Checklist not found");
    const loaded = await this.loadChecklistRow(u.orgId, updated.id);
    if (!loaded) throw new NotFoundException("Checklist not found");
    return { ...loaded, projectId };
  }

  async deleteChecklist(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    checklistId: number,
  ) {
    await this.requireChecklistInTicket(u, projectId, ticketId, checklistId);
    const [deleted] = await this.db
      .delete(ticketChecklists)
      .where(
        and(
          eq(ticketChecklists.id, checklistId),
          eq(ticketChecklists.ticketId, ticketId),
          eq(ticketChecklists.orgId, u.orgId),
        ),
      )
      .returning();
    if (!deleted) throw new NotFoundException("Checklist not found");
    return { success: true };
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
    await this.requireChecklistInTicket(u, projectId, ticketId, checklistId);

    const [item] = await this.db
      .insert(ticketChecklistItems)
      .values({
        orgId: u.orgId,
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
    await this.requireChecklistInTicket(u, projectId, ticketId, checklistId);

    const existing = await this.db.query.ticketChecklistItems.findFirst({
      where: and(
        eq(ticketChecklistItems.id, itemId),
        eq(ticketChecklistItems.checklistId, checklistId),
        eq(ticketChecklistItems.orgId, u.orgId),
      ),
      columns: { id: true, checklistId: true },
    });
    if (!existing) throw new NotFoundException("Checklist item not found");

    const [item] = await this.db
      .update(ticketChecklistItems)
      .set(data)
      .where(
        and(
          eq(ticketChecklistItems.orgId, u.orgId),
          eq(ticketChecklistItems.checklistId, checklistId),
          eq(ticketChecklistItems.id, itemId),
        ),
      )
      .returning();
    if (!item) throw new NotFoundException("Checklist item not found");
    return toChecklistItemRow(item);
  }

  async deleteChecklistItem(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    checklistId: number,
    itemId: number,
  ) {
    await this.requireChecklistInTicket(u, projectId, ticketId, checklistId);

    const existing = await this.db.query.ticketChecklistItems.findFirst({
      where: and(
        eq(ticketChecklistItems.id, itemId),
        eq(ticketChecklistItems.checklistId, checklistId),
        eq(ticketChecklistItems.orgId, u.orgId),
      ),
      columns: { id: true, checklistId: true },
    });
    if (!existing) throw new NotFoundException("Checklist item not found");

    const [deleted] = await this.db
      .delete(ticketChecklistItems)
      .where(
        and(
          eq(ticketChecklistItems.orgId, u.orgId),
          eq(ticketChecklistItems.checklistId, checklistId),
          eq(ticketChecklistItems.id, itemId),
        ),
      )
      .returning();
    if (!deleted) throw new NotFoundException("Checklist item not found");
    return { success: true };
  }
}
