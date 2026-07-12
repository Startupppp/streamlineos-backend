import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, desc, eq, or, sql } from "drizzle-orm";
import {
  intakeItems,
  pages,
  projectMilestones,
  projectViews,
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
  IntakeListQuery,
  UpdateIntakeInput,
  UpdateMilestoneInput,
  UpdatePageInput,
  UpdateViewInput,
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
        submitterName: input.submitterName ?? null,
        priority: input.priority ?? null,
        requestType: input.requestType ?? null,
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

  listViews(orgId: string, userId: string, projectId: number) {
    return this.db
      .select()
      .from(projectViews)
      .where(
        and(
          eq(projectViews.projectId, projectId),
          eq(projectViews.orgId, orgId),
          or(eq(projectViews.visibility, "shared"), eq(projectViews.createdBy, userId)),
        ),
      )
      .orderBy(desc(projectViews.isPinned), desc(projectViews.updatedAt))
      .limit(100);
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
        visibility: input.visibility,
        displayOptions: input.displayOptions,
        scope: "project",
      })
      .returning();
    return view;
  }

  async updateView(orgId: string, userId: string, viewId: number, input: UpdateViewInput) {
    const existing = await this.db.query.projectViews.findFirst({
      where: and(eq(projectViews.id, viewId), eq(projectViews.orgId, orgId)),
      columns: { id: true, createdBy: true, visibility: true },
    });
    if (!existing) throw new NotFoundException("View not found");
    if (existing.createdBy !== userId && existing.visibility !== "shared") {
      throw new ForbiddenException("Cannot mutate a private view you do not own");
    }
    const [updated] = await this.db
      .update(projectViews)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(projectViews.id, viewId))
      .returning();
    return updated;
  }

  async deleteView(orgId: string, userId: string, viewId: number) {
    const existing = await this.db.query.projectViews.findFirst({
      where: and(eq(projectViews.id, viewId), eq(projectViews.orgId, orgId)),
      columns: { id: true, createdBy: true, visibility: true },
    });
    if (!existing) throw new NotFoundException("View not found");
    if (existing.createdBy !== userId && existing.visibility !== "shared") {
      throw new ForbiddenException("Cannot delete a private view you do not own");
    }
    await this.db.delete(projectViews).where(eq(projectViews.id, viewId));
    return { success: true };
  }

  listWorkspaceViews(orgId: string, userId: string) {
    return this.db
      .select()
      .from(projectViews)
      .where(
        and(
          eq(projectViews.orgId, orgId),
          eq(projectViews.scope, "workspace"),
          or(eq(projectViews.visibility, "shared"), eq(projectViews.createdBy, userId)),
        ),
      )
      .orderBy(desc(projectViews.isPinned), desc(projectViews.updatedAt))
      .limit(100);
  }

  async createWorkspaceView(orgId: string, userId: string, input: CreateViewInput) {
    const [view] = await this.db
      .insert(projectViews)
      .values({
        projectId: null,
        orgId,
        createdBy: userId,
        name: input.name,
        filters: input.filters,
        groupBy: input.groupBy,
        orderBy: input.orderBy,
        layoutType: input.layoutType,
        isPinned: input.isPinned,
        visibility: input.visibility,
        displayOptions: input.displayOptions,
        scope: "workspace",
      })
      .returning();
    return view;
  }

  async updateWorkspaceView(orgId: string, userId: string, viewId: number, input: UpdateViewInput) {
    const existing = await this.db.query.projectViews.findFirst({
      where: and(
        eq(projectViews.id, viewId),
        eq(projectViews.orgId, orgId),
        eq(projectViews.scope, "workspace"),
      ),
      columns: { id: true, createdBy: true, visibility: true },
    });
    if (!existing) throw new NotFoundException("Workspace view not found");
    if (existing.createdBy !== userId && existing.visibility !== "shared") {
      throw new ForbiddenException("Cannot mutate a private view you do not own");
    }
    const [updated] = await this.db
      .update(projectViews)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(projectViews.id, viewId))
      .returning();
    return updated;
  }

  async deleteWorkspaceView(orgId: string, userId: string, viewId: number) {
    const existing = await this.db.query.projectViews.findFirst({
      where: and(
        eq(projectViews.id, viewId),
        eq(projectViews.orgId, orgId),
        eq(projectViews.scope, "workspace"),
      ),
      columns: { id: true, createdBy: true, visibility: true },
    });
    if (!existing) throw new NotFoundException("Workspace view not found");
    if (existing.createdBy !== userId && existing.visibility !== "shared") {
      throw new ForbiddenException("Cannot delete a private view you do not own");
    }
    await this.db.delete(projectViews).where(eq(projectViews.id, viewId));
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
