import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, eq, or, isNull } from "drizzle-orm";
import {
  supportQueues,
  supportSavedViews,
  supportTags,
  supportTicketTags,
  supportTicketWatchers,
  supportTickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type {
  CreateQueueInput,
  CreateSavedViewInput,
  CreateTagInput,
  UpdateQueueInput,
  UpdateSavedViewInput,
} from "./dto/support.schemas";

@Injectable()
export class SupportWorkspaceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listQueues(orgId: string) {
    const queues = await this.db.query.supportQueues.findMany({
      where: eq(supportQueues.orgId, orgId),
      orderBy: [asc(supportQueues.sortOrder), asc(supportQueues.id)],
    });

    const counts = await this.db
      .select({ queueId: supportTickets.queueId, cnt: count() })
      .from(supportTickets)
      .where(and(eq(supportTickets.orgId, orgId), or(eq(supportTickets.status, "OPEN"), eq(supportTickets.status, "IN_PROGRESS"))))
      .groupBy(supportTickets.queueId);

    const countMap = new Map(counts.map((c) => [c.queueId, Number(c.cnt)]));

    return queues.map((queue) => ({ ...queue, openTicketCount: countMap.get(queue.id) ?? 0 }));
  }

  async createQueue(orgId: string, userId: string, input: CreateQueueInput) {
    const [queue] = await this.db
      .insert(supportQueues)
      .values({
        orgId,
        name: input.name,
        description: input.description ?? null,
        filter: input.filter,
        sortOrder: input.sortOrder,
        isDefault: input.isDefault,
        createdBy: userId,
      })
      .returning();
    return queue;
  }

  async updateQueue(orgId: string, queueId: number, input: UpdateQueueInput) {
    const [updated] = await this.db
      .update(supportQueues)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(supportQueues.id, queueId), eq(supportQueues.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Queue not found");
    return updated;
  }

  async deleteQueue(orgId: string, queueId: number) {
    const [deleted] = await this.db
      .delete(supportQueues)
      .where(and(eq(supportQueues.id, queueId), eq(supportQueues.orgId, orgId)))
      .returning();

    if (!deleted) throw new NotFoundException("Queue not found");
    return { success: true };
  }

  async listSavedViews(orgId: string, userId: string) {
    return this.db.query.supportSavedViews.findMany({
      where: and(
        eq(supportSavedViews.orgId, orgId),
        or(
          eq(supportSavedViews.ownerId, userId),
          eq(supportSavedViews.visibility, "team"),
          eq(supportSavedViews.visibility, "global"),
          isNull(supportSavedViews.ownerId),
        ),
      ),
      orderBy: [asc(supportSavedViews.sortOrder), asc(supportSavedViews.id)],
    });
  }

  async createSavedView(orgId: string, userId: string, input: CreateSavedViewInput) {
    const [view] = await this.db
      .insert(supportSavedViews)
      .values({
        orgId,
        ownerId: input.visibility === "personal" ? userId : null,
        name: input.name,
        filter: input.filter,
        visibility: input.visibility,
        sortOrder: input.sortOrder,
      })
      .returning();
    return view;
  }

  async updateSavedView(orgId: string, userId: string, viewId: number, input: UpdateSavedViewInput) {
    const view = await this.db.query.supportSavedViews.findFirst({
      where: and(eq(supportSavedViews.id, viewId), eq(supportSavedViews.orgId, orgId)),
    });
    if (!view) throw new NotFoundException("View not found");
    if (view.visibility === "personal" && view.ownerId !== userId) {
      throw new ForbiddenException("You can only edit your own personal views");
    }

    const [updated] = await this.db
      .update(supportSavedViews)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(supportSavedViews.id, viewId), eq(supportSavedViews.orgId, orgId)))
      .returning();
    return updated;
  }

  async deleteSavedView(orgId: string, userId: string, viewId: number) {
    const view = await this.db.query.supportSavedViews.findFirst({
      where: and(eq(supportSavedViews.id, viewId), eq(supportSavedViews.orgId, orgId)),
    });
    if (!view) throw new NotFoundException("View not found");
    if (view.visibility === "personal" && view.ownerId !== userId) {
      throw new ForbiddenException("You can only delete your own personal views");
    }

    await this.db
      .delete(supportSavedViews)
      .where(and(eq(supportSavedViews.id, viewId), eq(supportSavedViews.orgId, orgId)));
    return { success: true };
  }

  listTags(orgId: string) {
    return this.db.query.supportTags.findMany({
      where: eq(supportTags.orgId, orgId),
      orderBy: [asc(supportTags.name)],
      limit: 100,
    });
  }

  async listTicketTags(orgId: string, ticketId: number) {
    await this.assertTicketInOrg(orgId, ticketId);
    const rows = await this.db.query.supportTicketTags.findMany({
      where: eq(supportTicketTags.ticketId, ticketId),
      with: { tag: true },
    });
    return rows.map((row) => row.tag).filter((tag) => tag.orgId === orgId);
  }

  async createTag(orgId: string, input: CreateTagInput) {
    const existing = await this.db.query.supportTags.findFirst({
      where: and(eq(supportTags.orgId, orgId), eq(supportTags.name, input.name)),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("A tag with this name already exists");

    const [tag] = await this.db
      .insert(supportTags)
      .values({ orgId, name: input.name, color: input.color ?? null })
      .returning();
    return tag;
  }

  async attachTag(orgId: string, ticketId: number, tagId: number) {
    await this.assertTicketInOrg(orgId, ticketId);
    const tag = await this.db.query.supportTags.findFirst({
      where: and(eq(supportTags.id, tagId), eq(supportTags.orgId, orgId)),
      columns: { id: true },
    });
    if (!tag) throw new NotFoundException("Tag not found");

    await this.db
      .insert(supportTicketTags)
      .values({ ticketId, tagId })
      .onConflictDoNothing();
    return { success: true };
  }

  async detachTag(orgId: string, ticketId: number, tagId: number) {
    await this.assertTicketInOrg(orgId, ticketId);
    await this.db
      .delete(supportTicketTags)
      .where(and(eq(supportTicketTags.ticketId, ticketId), eq(supportTicketTags.tagId, tagId)));
    return { success: true };
  }

  async follow(orgId: string, ticketId: number, userId: string) {
    await this.assertTicketInOrg(orgId, ticketId);
    await this.db
      .insert(supportTicketWatchers)
      .values({ orgId, ticketId, userId })
      .onConflictDoNothing();
    return { success: true };
  }

  async unfollow(orgId: string, ticketId: number, userId: string) {
    await this.assertTicketInOrg(orgId, ticketId);
    await this.db
      .delete(supportTicketWatchers)
      .where(
        and(
          eq(supportTicketWatchers.orgId, orgId),
          eq(supportTicketWatchers.ticketId, ticketId),
          eq(supportTicketWatchers.userId, userId),
        ),
      );
    return { success: true };
  }

  listWatchers(orgId: string, ticketId: number) {
    return this.db.query.supportTicketWatchers.findMany({
      where: and(eq(supportTicketWatchers.orgId, orgId), eq(supportTicketWatchers.ticketId, ticketId)),
      with: { user: { columns: { id: true, name: true, image: true } } },
    });
  }

  private async assertTicketInOrg(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
  }
}
