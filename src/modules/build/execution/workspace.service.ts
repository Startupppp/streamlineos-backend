import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { BuildTicketCreationService, TicketVersionConflictException } from "../core/tickets";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import {
  intakeItems,
  organizationMembers,
  projectMilestones,
  projectStatuses,
  projectViews,
  tickets,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import { AuditService } from "../../../common/audit/audit.service";
import {
  assertRestorable,
  clearingLifecycle,
} from "../lifecycle/lifecycle-restore";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { assertProjectAccess, escapeLike, assertProjectInOrg } from "../core";
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
    private readonly audit: AuditService,
  ) {}

  async listMilestones(u: CurrentUserContext, projectId: number, query: ListMilestonesQuery) {
    const { orgId } = u;
    await assertProjectAccess(this.db, this.access, u, projectId);
    const { cursor, limit, status, q, from, to, ownerId } = query;
    const pos = decodeIntegerCursor(cursor ?? null);
    const rawRows = await this.db
      .select({
        id: projectMilestones.id,
        projectId: projectMilestones.projectId,
        orgId: projectMilestones.orgId,
        name: projectMilestones.name,
        description: projectMilestones.description,
        targetDate: projectMilestones.targetDate,
        status: projectMilestones.status,
        createdBy: projectMilestones.createdBy,
        ownerMembershipId: projectMilestones.ownerMembershipId,
        clientVisible: projectMilestones.clientVisible,
        version: projectMilestones.version,
        deletedAt: projectMilestones.deletedAt,
        createdAt: projectMilestones.createdAt,
        updatedAt: projectMilestones.updatedAt,
        ownerFirstName: users.firstName,
        ownerLastName: users.lastName,
        ownerImage: users.image,
      })
      .from(projectMilestones)
      .leftJoin(organizationMembers, and(eq(organizationMembers.orgId, projectMilestones.orgId), eq(organizationMembers.id, projectMilestones.ownerMembershipId)))
      .leftJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(
        eq(projectMilestones.projectId, projectId),
        eq(projectMilestones.orgId, orgId),
        isNull(projectMilestones.deletedAt),
        status ? eq(projectMilestones.status, status) : undefined,
        q ? sql`${projectMilestones.name} ILIKE ${`%${escapeLike(q)}%`}` : undefined,
        from ? gte(projectMilestones.targetDate, from) : undefined,
        to ? lte(projectMilestones.targetDate, to) : undefined,
        ownerId ? eq(projectMilestones.ownerMembershipId, ownerId) : undefined,
        pos ? keysetAfterId(projectMilestones.targetDate, projectMilestones.id, pos) : undefined,
      ))
      .orderBy(asc(projectMilestones.targetDate), asc(projectMilestones.id))
      .limit(limit + 1);
    const rawPage = buildCursorPage(rawRows, limit, (row) => ({
      sortValue: row.targetDate ?? "",
      id: String(row.id),
    }));
    const counts = await this.linkedWorkCounts(orgId, rawPage.data.map((r) => r.id));
    return {
      ...rawPage,
      data: rawPage.data.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        orgId: row.orgId,
        name: row.name,
        description: row.description,
        targetDate: row.targetDate,
        status: row.status,
        createdBy: row.createdBy,
        ownerMembershipId: row.ownerMembershipId ?? null,
        owner: row.ownerMembershipId != null
          ? { membershipId: row.ownerMembershipId, firstName: row.ownerFirstName ?? null, lastName: row.ownerLastName ?? null, image: row.ownerImage ?? null }
          : null,
        linkedTicketCount: counts.get(row.id)?.linked ?? 0,
        completedTicketCount: counts.get(row.id)?.completed ?? 0,
        clientVisible: row.clientVisible,
        version: row.version,
        deletedAt: row.deletedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    };
  }

  private async linkedWorkCounts(orgId: string, milestoneIds: number[]): Promise<Map<number, { linked: number; completed: number }>> {
    const byMilestone = new Map<number, { linked: number; completed: number }>();
    if (milestoneIds.length === 0) return byMilestone;
    const countRows = await this.db
      .select({
        milestoneId: tickets.milestoneId,
        linked: sql<number>`CAST(count(*) AS int)`,
        completed: sql<number>`CAST(count(*) FILTER (WHERE ${projectStatuses.type} = 'completed') AS int)`,
      })
      .from(tickets)
      .leftJoin(
        projectStatuses,
        and(
          eq(tickets.orgId, projectStatuses.orgId),
          eq(tickets.projectId, projectStatuses.projectId),
          eq(tickets.status, projectStatuses.name),
        ),
      )
      .where(and(eq(tickets.orgId, orgId), inArray(tickets.milestoneId, milestoneIds), isNull(tickets.deletedAt)))
      .groupBy(tickets.milestoneId);
    for (const r of countRows) {
      if (r.milestoneId != null) byMilestone.set(r.milestoneId, { linked: r.linked, completed: r.completed });
    }
    return byMilestone;
  }

  private async assertOwnerInOrg(orgId: string, ownerMembershipId: number | null | undefined): Promise<void> {
    if (ownerMembershipId == null) return;
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.id, ownerMembershipId), eq(organizationMembers.orgId, orgId)),
      columns: { id: true },
    });
    if (!member) throw new BadRequestException("The provided owner does not belong to this organization");
  }

  async createMilestone(u: CurrentUserContext, projectId: number, input: CreateMilestoneInput) {
    const { orgId, userId } = u;
    await assertProjectAccess(this.db, this.access, u, projectId);
    await this.assertOwnerInOrg(orgId, input.ownerMembershipId);
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
        ownerMembershipId: input.ownerMembershipId ?? null,
      })
      .returning();
    const ownerMembershipId = milestone.ownerMembershipId ?? null;
    return {
      ...milestone,
      owner: ownerMembershipId != null ? { membershipId: ownerMembershipId, firstName: null as string | null, lastName: null as string | null, image: null as string | null } : null,
      linkedTicketCount: 0,
      completedTicketCount: 0,
    };
  }

  async updateMilestone(u: CurrentUserContext, projectId: number, milestoneId: number, input: UpdateMilestoneInput) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const { orgId } = u;
    const before = await this.db.query.projectMilestones.findFirst({
      where: and(eq(projectMilestones.id, milestoneId), eq(projectMilestones.projectId, projectId), eq(projectMilestones.orgId, orgId), isNull(projectMilestones.deletedAt)),
      columns: { version: true, ownerMembershipId: true },
    });
    if (!before) throw new NotFoundException("Milestone not found");
    if (input.version !== before.version) throw new TicketVersionConflictException(before.version);
    await this.assertOwnerInOrg(orgId, input.ownerMembershipId);

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
    const ownerMembershipId = updated.ownerMembershipId ?? null;
    const counts = await this.linkedWorkCounts(orgId, [milestoneId]);
    return {
      ...updated,
      owner: ownerMembershipId != null ? { membershipId: ownerMembershipId, firstName: null as string | null, lastName: null as string | null, image: null as string | null } : null,
      linkedTicketCount: counts.get(milestoneId)?.linked ?? 0,
      completedTicketCount: counts.get(milestoneId)?.completed ?? 0,
    };
  }

  async deleteMilestone(u: CurrentUserContext, projectId: number, milestoneId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const { orgId, userId } = u;
    const [stamped] = await this.db
      .update(projectMilestones)
      .set({ deletedAt: new Date() })
      .where(and(eq(projectMilestones.id, milestoneId), eq(projectMilestones.projectId, projectId), eq(projectMilestones.orgId, orgId), isNull(projectMilestones.deletedAt)))
      .returning({ id: projectMilestones.id });
    if (!stamped) throw new NotFoundException("Milestone not found");
    this.audit.log({
      action: "build.milestone.deleted",
      userId,
      orgId,
      resourceType: "project_milestone",
      resourceId: String(milestoneId),
      metadata: { milestoneId, projectId },
    });
    return { success: true };
  }

  async restoreMilestone(u: CurrentUserContext, projectId: number, milestoneId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const { orgId, userId } = u;
    const existing = await this.db.query.projectMilestones.findFirst({
      where: and(
        eq(projectMilestones.id, milestoneId),
        eq(projectMilestones.projectId, projectId),
        eq(projectMilestones.orgId, orgId),
      ),
      columns: { deletedAt: true },
    });
    assertRestorable(existing, "Milestone");
    const [restored] = await clearingLifecycle("Milestone", () =>
      this.db
        .update(projectMilestones)
        .set({ deletedAt: null })
        .where(
          and(
            eq(projectMilestones.id, milestoneId),
            eq(projectMilestones.projectId, projectId),
            eq(projectMilestones.orgId, orgId),
            isNotNull(projectMilestones.deletedAt),
          ),
        )
        .returning({ id: projectMilestones.id }),
    );
    if (!restored) throw new NotFoundException("Milestone not found");
    this.audit.log({
      action: "build.milestone.restored",
      userId,
      orgId,
      resourceType: "project_milestone",
      resourceId: String(milestoneId),
      metadata: { milestoneId, projectId },
    });
    return { success: true };
  }
}

@Injectable()
export class IntakeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ticketCreation: BuildTicketCreationService,
  ) {}

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
      let createdResult: Awaited<ReturnType<BuildTicketCreationService["createInTransaction"]>>;
      const response = await this.db.transaction(async (tx) => {
        const description =
          typeof item.description === "object"
            ? JSON.stringify(item.description)
            : typeof item.description === "string"
              ? item.description
              : "";

        createdResult = await this.ticketCreation.createInTransaction(tx, {
          orgId,
          projectId: item.projectId,
          actor: { userId, membershipId: null },
          drafts: [{
            title: item.title,
            description,
            reporterId: userId,
          }],
        });
        const ticket = createdResult.tickets[0]!;

        const [updated] = await tx
          .update(intakeItems)
          .set({ status: "accepted", linkedWorkItemId: ticket.id, updatedAt: new Date() })
          .where(and(eq(intakeItems.id, requestId), eq(intakeItems.orgId, orgId)))
          .returning();

        return { ...updated, linkedTicket: ticket };
      });
      this.ticketCreation.publish(createdResult!);
      return response;
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
    const { limit, cursor, search } = query;
    const pos = decodeTupleCursor(cursor, 3);

    const conds: (SQL | undefined)[] = [
      eq(projectViews.projectId, projectId),
      eq(projectViews.orgId, orgId),
      or(eq(projectViews.visibility, "shared"), eq(projectViews.createdBy, userId)),
      search ? sql`${projectViews.name} ILIKE ${`${escapeLike(search)}%`}` : undefined,
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

