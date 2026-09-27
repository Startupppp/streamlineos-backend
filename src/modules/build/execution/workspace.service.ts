import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { TicketVersionConflictException, reserveTicketCapacity } from "../core/tickets";
import { and, asc, desc, eq, gte, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import {
  intakeItems,
  projectMilestones,
  projectViews,
  tickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { assertProjectAccess, allocateTicketNumbers, escapeLike, assertProjectInOrg } from "../core";
import { buildCursorPage, buildTupleCursorPage, decodeCursor, decodeIntegerCursor, decodeTupleCursor } from "../../../common/pagination/cursor";
import { keysetAfterId, keysetBeforeId, keysetBeforeTuple, keysetBoolean, keysetTimestamp, keysetInteger } from "../../../common/pagination/keyset";
import type {
  CreateIntakeInput,
  CreateMilestoneInput,
  CreateViewInput,
  IntakeListQuery,
  ListMilestonesQuery,
  ListViewsQuery,
  UpdateIntakeInput,
  UpdateMilestoneInput,
  UpdateViewInput,
} from "./dto/workspace.schemas";

@Injectable()
export class MilestonesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async listMilestones(u: CurrentUserContext, projectId: number, query: ListMilestonesQuery) {
    const { orgId } = u;
    await assertProjectAccess(this.db, this.access, u, projectId);
    const { cursor, limit, status, q, from, to } = query;
    const pos = decodeIntegerCursor(cursor ?? null);
    const rows = await this.db
      .select({
        id: projectMilestones.id,
        projectId: projectMilestones.projectId,
        orgId: projectMilestones.orgId,
        name: projectMilestones.name,
        description: projectMilestones.description,
        targetDate: projectMilestones.targetDate,
        status: projectMilestones.status,
        createdBy: projectMilestones.createdBy,
        clientVisible: projectMilestones.clientVisible,
        version: projectMilestones.version,
        deletedAt: projectMilestones.deletedAt,
        createdAt: projectMilestones.createdAt,
        updatedAt: projectMilestones.updatedAt,
      })
      .from(projectMilestones)
      .where(and(
        eq(projectMilestones.projectId, projectId),
        eq(projectMilestones.orgId, orgId),
        isNull(projectMilestones.deletedAt),
        status ? eq(projectMilestones.status, status) : undefined,
        q ? sql`${projectMilestones.name} ILIKE ${`%${escapeLike(q)}%`}` : undefined,
        from ? gte(projectMilestones.targetDate, from) : undefined,
        to ? lte(projectMilestones.targetDate, to) : undefined,
        pos ? keysetAfterId(projectMilestones.targetDate, projectMilestones.id, pos) : undefined,
      ))
      .orderBy(asc(projectMilestones.targetDate), asc(projectMilestones.id))
      .limit(limit + 1);
    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.targetDate ?? "",
      id: String(row.id),
    }));
  }

  async createMilestone(u: CurrentUserContext, projectId: number, input: CreateMilestoneInput) {
    const { orgId, userId } = u;
    await assertProjectAccess(this.db, this.access, u, projectId);
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

  async updateMilestone(orgId: string, projectId: number, milestoneId: number, input: UpdateMilestoneInput) {
    const before = await this.db.query.projectMilestones.findFirst({
      where: and(eq(projectMilestones.id, milestoneId), eq(projectMilestones.projectId, projectId), eq(projectMilestones.orgId, orgId), isNull(projectMilestones.deletedAt)),
      columns: { version: true },
    });
    if (!before) throw new NotFoundException("Milestone not found");
    if (input.version !== before.version) throw new TicketVersionConflictException(before.version);

    const { version: _v, ...rest } = input;
    const [updated] = await this.db
      .update(projectMilestones)
      .set({ ...rest, updatedAt: new Date() })
      .where(and(eq(projectMilestones.id, milestoneId), eq(projectMilestones.projectId, projectId), eq(projectMilestones.orgId, orgId), isNull(projectMilestones.deletedAt), eq(projectMilestones.version, before.version)))
      .returning();
    if (!updated) {
      const [current] = await this.db.select({ version: projectMilestones.version }).from(projectMilestones).where(and(eq(projectMilestones.id, milestoneId), eq(projectMilestones.orgId, orgId))).limit(1);
      throw new TicketVersionConflictException(current?.version ?? before.version);
    }
    return updated;
  }

  async deleteMilestone(orgId: string, projectId: number, milestoneId: number) {
    const [stamped] = await this.db
      .update(projectMilestones)
      .set({ deletedAt: new Date() })
      .where(and(eq(projectMilestones.id, milestoneId), eq(projectMilestones.projectId, projectId), eq(projectMilestones.orgId, orgId), isNull(projectMilestones.deletedAt)))
      .returning({ id: projectMilestones.id });
    if (!stamped) throw new NotFoundException("Milestone not found");
    return { success: true };
  }
}

@Injectable()
export class IntakeService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listIntake(orgId: string, projectId: number, query: IntakeListQuery) {
    await assertProjectInOrg(this.db, orgId, projectId);
    const { limit, cursor } = query;
    const pos = decodeCursor(cursor);

    const conds = [eq(intakeItems.projectId, projectId), eq(intakeItems.orgId, orgId)];
    if (query.status) conds.push(eq(intakeItems.status, query.status));
    if (pos) conds.push(keysetBeforeId(intakeItems.createdAt, intakeItems.id, pos));

    const intakeCols = {
      id: intakeItems.id,
      projectId: intakeItems.projectId,
      orgId: intakeItems.orgId,
      title: intakeItems.title,
      description: intakeItems.description,
      source: intakeItems.source,
      status: intakeItems.status,
      submitterEmail: intakeItems.submitterEmail,
      submitterName: intakeItems.submitterName,
      priority: intakeItems.priority,
      requestType: intakeItems.requestType,
      linkedWorkItemId: intakeItems.linkedWorkItemId,
      declineReason: intakeItems.declineReason,
      createdAt: intakeItems.createdAt,
      updatedAt: intakeItems.updatedAt,
    };
    const rows = await this.db
      .select(intakeCols)
      .from(intakeItems)
      .where(and(...conds))
      .orderBy(desc(intakeItems.createdAt), desc(intakeItems.id))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (r) => ({
      sortValue: (r.createdAt ?? new Date(0)).toISOString(),
      id: String(r.id),
    }));
    return { data: page.data, pagination: page.pagination };
  }

  async createIntake(orgId: string, projectId: number, input: CreateIntakeInput) {
    // `listIntake` above resolves the project; this did not, so a cross-tenant `:projectId`
    // reached the INSERT and the composite tenant FK refused it with an uncaught 23503.
    await assertProjectInOrg(this.db, orgId, projectId);
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

  async updateIntake(orgId: string, userId: string, projectId: number, requestId: number, input: UpdateIntakeInput) {
    const [item] = await this.db
      .select()
      .from(intakeItems)
      .where(and(eq(intakeItems.id, requestId), eq(intakeItems.projectId, projectId), eq(intakeItems.orgId, orgId)))
      .limit(1);

    if (!item) throw new NotFoundException("Intake request not found");
    if (item.status !== "pending") {
      throw new ConflictException("This request has already been processed.");
    }

    if (input.status === "accepted") {
      return this.db.transaction(async (tx) => {
        await reserveTicketCapacity(tx, orgId, item.projectId, [{ status: "TODO", count: 1 }]);
        const ticketNumber = await allocateTicketNumbers(tx, orgId, item.projectId);

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
            ticketNumber,
            reporterId: userId,
          })
          .returning();

        const [updated] = await tx
          .update(intakeItems)
          .set({ status: "accepted", linkedWorkItemId: ticket.id, updatedAt: new Date() })
          .where(and(eq(intakeItems.id, requestId), eq(intakeItems.orgId, orgId)))
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
        .where(and(eq(intakeItems.id, requestId), eq(intakeItems.orgId, orgId)))
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
        .where(and(eq(intakeItems.id, requestId), eq(intakeItems.orgId, orgId)))
        .returning();
      return updated;
    }

    throw new BadRequestException("No valid status transition provided.");
  }
}

@Injectable()
export class ViewsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listViews(orgId: string, userId: string, projectId: number, query: ListViewsQuery = { limit: 25 }) {
    await assertProjectInOrg(this.db, orgId, projectId);
    const { limit, cursor } = query;
    const pos = decodeTupleCursor(cursor, 3);

    const conds: (SQL | undefined)[] = [
      eq(projectViews.projectId, projectId),
      eq(projectViews.orgId, orgId),
      or(eq(projectViews.visibility, "shared"), eq(projectViews.createdBy, userId)),
    ];

    if (pos) {
      const [pinnedStr, updatedStr, idStr] = pos;
      conds.push(
        keysetBeforeTuple([
          { column: projectViews.isPinned, value: keysetBoolean(pinnedStr) },
          { column: projectViews.updatedAt, value: keysetTimestamp(updatedStr) },
          { column: projectViews.id, value: keysetInteger(idStr) },
        ]),
      );
    }

    const rows = await this.db
      .select()
      .from(projectViews)
      .where(and(...conds))
      .orderBy(desc(projectViews.isPinned), desc(projectViews.updatedAt), desc(projectViews.id))
      .limit(limit + 1);

    return buildTupleCursorPage(rows, limit, (row) => [
      row.isPinned ? "1" : "0",
      row.updatedAt.toISOString(),
      String(row.id),
    ]);
  }

  async createView(orgId: string, userId: string, projectId: number, input: CreateViewInput) {
    // `listViews` above resolves the project; this did not — same uncaught 23503 as `createIntake`.
    await assertProjectInOrg(this.db, orgId, projectId);
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

  async updateView(orgId: string, userId: string, projectId: number, viewId: number, input: UpdateViewInput) {
    const existing = await this.db.query.projectViews.findFirst({
      where: and(eq(projectViews.id, viewId), eq(projectViews.projectId, projectId), eq(projectViews.orgId, orgId)),
      columns: { id: true, createdBy: true, visibility: true },
    });
    if (!existing) throw new NotFoundException("View not found");
    if (existing.createdBy !== userId && existing.visibility !== "shared") {
      throw new ForbiddenException("Cannot mutate a private view you do not own");
    }
    const [updated] = await this.db
      .update(projectViews)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(projectViews.id, viewId), eq(projectViews.orgId, orgId)))
      .returning();
    return updated;
  }

  async deleteView(orgId: string, userId: string, projectId: number, viewId: number) {
    const existing = await this.db.query.projectViews.findFirst({
      where: and(eq(projectViews.id, viewId), eq(projectViews.projectId, projectId), eq(projectViews.orgId, orgId)),
      columns: { id: true, createdBy: true, visibility: true },
    });
    if (!existing) throw new NotFoundException("View not found");
    if (existing.createdBy !== userId && existing.visibility !== "shared") {
      throw new ForbiddenException("Cannot delete a private view you do not own");
    }
    await this.db.delete(projectViews).where(and(eq(projectViews.id, viewId), eq(projectViews.orgId, orgId)));
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
      .where(and(eq(projectViews.id, viewId), eq(projectViews.orgId, orgId)))
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
    await this.db.delete(projectViews).where(and(eq(projectViews.id, viewId), eq(projectViews.orgId, orgId)));
    return { success: true };
  }
}

