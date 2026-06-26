import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import {
  intakeItems,
  pages,
  projectMilestones,
  projectViews,
  projectWhiteboards,
  projects,
  tickets,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type {
  CreateIntakeInput,
  CreateMilestoneInput,
  CreatePageInput,
  CreateViewInput,
  CreateWhiteboardInput,
  IntakeListQuery,
  UpdateIntakeInput,
  UpdateMilestoneInput,
  UpdatePageInput,
  UpdateViewInput,
  UpdateWhiteboardInput,
} from "./dto/workspace.schemas";

async function assertProject(db: Db, orgId: string, projectId: number): Promise<void> {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
    columns: { id: true },
  });
  if (!project) throw new NotFoundException("Project not found");
}

@Injectable()
export class MilestonesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listMilestones(orgId: string, projectId: number) {
    await assertProject(this.db, orgId, projectId);
    return this.db.query.projectMilestones.findMany({
      where: and(eq(projectMilestones.projectId, projectId), eq(projectMilestones.orgId, orgId)),
      orderBy: [asc(projectMilestones.targetDate)],
    });
  }

  async createMilestone(orgId: string, userId: string, projectId: number, input: CreateMilestoneInput) {
    await assertProject(this.db, orgId, projectId);
    const [milestone] = await this.db
      .insert(projectMilestones)
      .values({
        projectId,
        orgId,
        name: input.name,
        description: input.description ?? null,
        targetDate: input.targetDate,
        status: input.status,
        createdBy: userId,
      })
      .returning();
    return milestone;
  }

  async updateMilestone(orgId: string, milestoneId: number, input: UpdateMilestoneInput) {
    const [updated] = await this.db
      .update(projectMilestones)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(projectMilestones.id, milestoneId), eq(projectMilestones.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Milestone not found");
    return updated;
  }

  async deleteMilestone(orgId: string, milestoneId: number) {
    const [deleted] = await this.db
      .delete(projectMilestones)
      .where(and(eq(projectMilestones.id, milestoneId), eq(projectMilestones.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Milestone not found");
    return { success: true };
  }
}

@Injectable()
export class IntakeService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listIntake(orgId: string, projectId: number, query: IntakeListQuery) {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const conditions = [eq(intakeItems.projectId, projectId), eq(intakeItems.orgId, orgId)];
    if (query.status) conditions.push(eq(intakeItems.status, query.status));

    const [totalResult] = await this.db
      .select({ count: count() })
      .from(intakeItems)
      .where(and(...conditions));

    const items = await this.db
      .select()
      .from(intakeItems)
      .where(and(...conditions))
      .orderBy(desc(intakeItems.createdAt))
      .limit(limit)
      .offset(offset);

    return { items, total: Number(totalResult?.count ?? 0) };
  }

  async createIntake(orgId: string, projectId: number, input: CreateIntakeInput) {
    const [item] = await this.db
      .insert(intakeItems)
      .values({
        projectId,
        orgId,
        title: input.title,
        description: input.description ?? null,
        source: input.source,
        submitterEmail: input.submitterEmail,
      })
      .returning();
    return item;
  }

  async updateIntake(orgId: string, userId: string, requestId: number, input: UpdateIntakeInput) {
    const [item] = await this.db
      .select()
      .from(intakeItems)
      .where(and(eq(intakeItems.id, requestId), eq(intakeItems.orgId, orgId)));

    if (!item) throw new NotFoundException("Intake request not found");
    if (item.status !== "pending") {
      throw new ConflictException("This request has already been processed.");
    }

    if (input.status === "accepted") {
      return this.db.transaction(async (tx) => {
        const [maxTicket] = await tx
          .select({ max: sql<number>`COALESCE(MAX(${tickets.ticketNumber}), 0)` })
          .from(tickets)
          .where(eq(tickets.projectId, item.projectId));

        const description =
          typeof item.description === "object"
            ? JSON.stringify(item.description)
            : typeof item.description === "string"
              ? item.description
              : "";

        const [ticket] = await tx
          .insert(tickets)
          .values({
            orgId,
            projectId: item.projectId,
            title: item.title,
            description,
            ticketNumber: (maxTicket?.max ?? 0) + 1,
            reporterId: userId,
          })
          .returning();

        const [updated] = await tx
          .update(intakeItems)
          .set({ status: "accepted", linkedWorkItemId: ticket.id, updatedAt: new Date() })
          .where(eq(intakeItems.id, requestId))
          .returning();

        return { ...updated, linkedTicket: ticket };
      });
    }

    if (input.status === "declined") {
      if (!input.declineReason) {
        throw new BadRequestException("declineReason is required when declining a request.");
      }
      const [updated] = await this.db
        .update(intakeItems)
        .set({ status: "declined", declineReason: input.declineReason, updatedAt: new Date() })
        .where(eq(intakeItems.id, requestId))
        .returning();
      return updated;
    }

    if (input.status === "duplicate") {
      if (!input.linkedWorkItemId) {
        throw new BadRequestException("linkedWorkItemId is required when marking as duplicate.");
      }
      const [updated] = await this.db
        .update(intakeItems)
        .set({ status: "duplicate", linkedWorkItemId: input.linkedWorkItemId, updatedAt: new Date() })
        .where(eq(intakeItems.id, requestId))
        .returning();
      return updated;
    }

    throw new BadRequestException("No valid status transition provided.");
  }
}

@Injectable()
export class ViewsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listViews(orgId: string, projectId: number) {
    return this.db
      .select()
      .from(projectViews)
      .where(and(eq(projectViews.projectId, projectId), eq(projectViews.orgId, orgId)))
      .orderBy(desc(projectViews.isPinned), projectViews.name);
  }

  async createView(orgId: string, userId: string, projectId: number, input: CreateViewInput) {
    const [view] = await this.db
      .insert(projectViews)
      .values({
        projectId,
        orgId,
        createdBy: userId,
        name: input.name,
        filters: input.filters,
        groupBy: input.groupBy,
        orderBy: input.orderBy,
        layoutType: input.layoutType,
        isPinned: input.isPinned,
      })
      .returning();
    return view;
  }

  async updateView(orgId: string, viewId: number, input: UpdateViewInput) {
    const [updated] = await this.db
      .update(projectViews)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(projectViews.id, viewId), eq(projectViews.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("View not found");
    return updated;
  }

  async deleteView(orgId: string, viewId: number) {
    await this.db
      .delete(projectViews)
      .where(and(eq(projectViews.id, viewId), eq(projectViews.orgId, orgId)));
    return { success: true };
  }
}

@Injectable()
export class WhiteboardsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listWhiteboards(orgId: string, projectId: number) {
    await assertProject(this.db, orgId, projectId);
    const boards = await this.db.query.projectWhiteboards.findMany({
      where: and(eq(projectWhiteboards.projectId, projectId), eq(projectWhiteboards.orgId, orgId)),
      orderBy: [desc(projectWhiteboards.updatedAt)],
      columns: { id: true, name: true, data: true, updatedAt: true },
    });

    return boards.map((board) => ({
      id: board.id,
      name: board.name,
      elementCount: board.data.length,
      updatedAt: board.updatedAt,
    }));
  }

  async createWhiteboard(orgId: string, userId: string, projectId: number, input: CreateWhiteboardInput) {
    await assertProject(this.db, orgId, projectId);
    const [board] = await this.db
      .insert(projectWhiteboards)
      .values({ projectId, orgId, name: input.name, data: [], createdBy: userId })
      .returning();
    return board;
  }

  async getWhiteboard(orgId: string, projectId: number, whiteboardId: number) {
    await assertProject(this.db, orgId, projectId);
    const board = await this.db.query.projectWhiteboards.findFirst({
      where: and(
        eq(projectWhiteboards.id, whiteboardId),
        eq(projectWhiteboards.projectId, projectId),
        eq(projectWhiteboards.orgId, orgId),
      ),
    });
    if (!board) throw new NotFoundException("Whiteboard not found");
    return board;
  }

  async updateWhiteboard(orgId: string, projectId: number, whiteboardId: number, input: UpdateWhiteboardInput) {
    await assertProject(this.db, orgId, projectId);
    const [updated] = await this.db
      .update(projectWhiteboards)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.data !== undefined ? { data: input.data } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projectWhiteboards.id, whiteboardId),
          eq(projectWhiteboards.projectId, projectId),
          eq(projectWhiteboards.orgId, orgId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Whiteboard not found");
    return updated;
  }

  async deleteWhiteboard(orgId: string, projectId: number, whiteboardId: number) {
    await assertProject(this.db, orgId, projectId);
    const [deleted] = await this.db
      .delete(projectWhiteboards)
      .where(
        and(
          eq(projectWhiteboards.id, whiteboardId),
          eq(projectWhiteboards.projectId, projectId),
          eq(projectWhiteboards.orgId, orgId),
        ),
      )
      .returning();
    if (!deleted) throw new NotFoundException("Whiteboard not found");
    return { success: true };
  }
}

@Injectable()
export class PagesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listPages(orgId: string, projectId: number) {
    return this.db
      .select()
      .from(pages)
      .where(and(eq(pages.projectId, projectId), eq(pages.orgId, orgId)))
      .orderBy(asc(pages.title));
  }

  async createPage(orgId: string, userId: string, projectId: number, input: CreatePageInput) {
    const [page] = await this.db
      .insert(pages)
      .values({
        projectId,
        orgId,
        title: input.title,
        content: input.content ?? null,
        icon: input.icon,
        parentPageId: input.parentPageId,
        createdBy: userId,
      })
      .returning();
    return page;
  }

  async updatePage(orgId: string, pageId: number, input: UpdatePageInput) {
    const [updated] = await this.db
      .update(pages)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(pages.id, pageId), eq(pages.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Page not found");
    return updated;
  }

  async deletePage(orgId: string, pageId: number) {
    await this.db.update(pages).set({ parentPageId: null }).where(eq(pages.parentPageId, pageId));
    await this.db.delete(pages).where(and(eq(pages.id, pageId), eq(pages.orgId, orgId)));
    return { success: true };
  }
}
