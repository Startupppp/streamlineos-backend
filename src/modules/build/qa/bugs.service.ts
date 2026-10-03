import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, ilike, isNull, sql } from "drizzle-orm";
import { tickets, workItemQaDetails, projectStatuses, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { assertProjectAccess, escapeLike, assertProjectWriteAccess } from "../core";
import { AuditService } from "../../../common/audit/audit.service";
import type { BugListQuery, CreateBugInput, UpdateBugInput } from "./dto/bugs.schemas";
import { resolveWorkItemStatus, resolveTicketPriority } from "./bug-consolidation/bug-consolidation-mapping";
import { BuildTicketCreationService, ProjectsTicketsUpdateService, ProjectsTicketsDeleteService } from "../core/tickets";

@Injectable()
export class BugsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly ticketCreation: BuildTicketCreationService,
    private readonly ticketChange: ProjectsTicketsUpdateService,
    private readonly ticketDelete: ProjectsTicketsDeleteService,
  ) {}

  async listBugs(u: CurrentUserContext, projectId: number, query: BugListQuery) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const conditions = [
      eq(tickets.orgId, u.orgId),
      eq(tickets.projectId, projectId),
      eq(tickets.type, "BUG"),
      isNull(tickets.deletedAt),
    ];
    if (query.status) conditions.push(eq(workItemQaDetails.qaState, query.status));
    if (query.severity) conditions.push(eq(workItemQaDetails.severity, query.severity));
    if (query.assigneeId)
      conditions.push(
        sql`${tickets.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${u.orgId} AND user_id = ${query.assigneeId} AND status = 'ACTIVE')`,
      );
    if (query.q) conditions.push(ilike(tickets.title, `${escapeLike(query.q)}%`));
    return this.db
      .select({
        id: tickets.id,
        orgId: tickets.orgId,
        projectId: tickets.projectId,
        ticketNumber: tickets.ticketNumber,
        title: tickets.title,
        description: tickets.description,
        type: tickets.type,
        status: tickets.status,
        priority: tickets.priority,
        assigneeMembershipId: tickets.assigneeMembershipId,
        reporterId: tickets.reporterId,
        deletedAt: tickets.deletedAt,
        createdAt: tickets.createdAt,
        updatedAt: tickets.updatedAt,
        qaState: workItemQaDetails.qaState,
        severity: workItemQaDetails.severity,
        stepsToReproduce: workItemQaDetails.stepsToReproduce,
        expectedResult: workItemQaDetails.expectedResult,
        actualResult: workItemQaDetails.actualResult,
        environment: workItemQaDetails.environment,
        browserDevice: workItemQaDetails.browserDevice,
        affectedReleaseId: workItemQaDetails.affectedReleaseId,
        fixedReleaseId: workItemQaDetails.fixedReleaseId,
        qaOwnerUserId: workItemQaDetails.qaOwnerUserId,
        qaOwnerMembershipId: workItemQaDetails.qaOwnerMembershipId,
        linkedTestCaseId: workItemQaDetails.linkedTestCaseId,
        reopenCount: workItemQaDetails.reopenCount,
        createdByUserId: workItemQaDetails.createdByUserId,
        version: tickets.version,
      })
      .from(tickets)
      .leftJoin(
        workItemQaDetails,
        and(eq(workItemQaDetails.orgId, tickets.orgId), eq(workItemQaDetails.workItemId, tickets.id)),
      )
      .where(and(...conditions))
      .orderBy(tickets.ticketNumber)
      .limit(100);
  }

  async getBug(u: CurrentUserContext, projectId: number, bugId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const rows = await this.db
      .select({
        id: tickets.id,
        orgId: tickets.orgId,
        projectId: tickets.projectId,
        ticketNumber: tickets.ticketNumber,
        title: tickets.title,
        description: tickets.description,
        type: tickets.type,
        status: tickets.status,
        priority: tickets.priority,
        assigneeMembershipId: tickets.assigneeMembershipId,
        reporterId: tickets.reporterId,
        deletedAt: tickets.deletedAt,
        createdAt: tickets.createdAt,
        updatedAt: tickets.updatedAt,
        qaState: workItemQaDetails.qaState,
        severity: workItemQaDetails.severity,
        stepsToReproduce: workItemQaDetails.stepsToReproduce,
        expectedResult: workItemQaDetails.expectedResult,
        actualResult: workItemQaDetails.actualResult,
        environment: workItemQaDetails.environment,
        browserDevice: workItemQaDetails.browserDevice,
        affectedReleaseId: workItemQaDetails.affectedReleaseId,
        fixedReleaseId: workItemQaDetails.fixedReleaseId,
        qaOwnerUserId: workItemQaDetails.qaOwnerUserId,
        qaOwnerMembershipId: workItemQaDetails.qaOwnerMembershipId,
        linkedTestCaseId: workItemQaDetails.linkedTestCaseId,
        reopenCount: workItemQaDetails.reopenCount,
        createdByUserId: workItemQaDetails.createdByUserId,
        version: tickets.version,
      })
      .from(tickets)
      .leftJoin(
        workItemQaDetails,
        and(eq(workItemQaDetails.orgId, tickets.orgId), eq(workItemQaDetails.workItemId, tickets.id)),
      )
      .where(
        and(
          eq(tickets.id, bugId),
          eq(tickets.orgId, u.orgId),
          eq(tickets.projectId, projectId),
          eq(tickets.type, "BUG"),
          isNull(tickets.deletedAt),
        ),
      );
    if (rows.length === 0) throw new NotFoundException("Bug not found");
    return rows[0]!;
  }

  async createBug(u: CurrentUserContext, projectId: number, input: CreateBugInput) {
    await assertProjectWriteAccess(this.db, this.access, u, projectId);
    const { result, createdResult } = await this.db.transaction(async (tx) => {
      const assigneeMembershipId = input.assigneeId
        ? (await tx.query.organizationMembers.findFirst({
            where: and(
              eq(organizationMembers.orgId, u.orgId),
              eq(organizationMembers.userId, input.assigneeId),
              eq(organizationMembers.status, "ACTIVE"),
            ),
            columns: { id: true },
          }))?.id ?? null
        : null;
      const availableStatuses = await tx
        .select({ id: projectStatuses.id, name: projectStatuses.name, order: projectStatuses.order, type: projectStatuses.type })
        .from(projectStatuses)
        .where(and(eq(projectStatuses.orgId, u.orgId), eq(projectStatuses.projectId, projectId)));
      const ticketStatus = resolveWorkItemStatus("new", availableStatuses);
      const ticketPriority = resolveTicketPriority(input.priority);
      const createdResult = await this.ticketCreation.createInTransaction(tx, {
        orgId: u.orgId,
        projectId,
        actor: { userId: u.userId, membershipId: null },
        drafts: [{
          title: input.title,
          description: input.description,
          type: "BUG",
          status: ticketStatus,
          priority: ticketPriority,
          assigneeMembershipId,
          reporterId: u.userId,
          automationAssigneeUserId: input.assigneeId ?? null,
        }],
      });
      const ticket = createdResult.tickets[0];
      if (!ticket) throw new Error("Ticket creation returned no ticket");
      await tx.insert(workItemQaDetails).values({
        orgId: u.orgId,
        workItemId: ticket.id,
        projectId,
        qaState: "new",
        severity: input.severity ?? "major",
        stepsToReproduce: input.stepsToReproduce ?? null,
        expectedResult: input.expectedResult ?? null,
        actualResult: input.actualResult ?? null,
        environment: input.environment ?? null,
        browserDevice: input.browserDevice ?? null,
        affectedReleaseId: input.affectedReleaseId ?? null,
        fixedReleaseId: input.fixedReleaseId ?? null,
        linkedTestCaseId: input.linkedTestCaseId ?? null,
        qaOwnerUserId: input.qaOwnerId ?? null,
        createdByUserId: u.userId,
      });
      const result = {
        ...ticket,
        qaState: "new" as const,
        severity: input.severity ?? ("major" as const),
        stepsToReproduce: input.stepsToReproduce ?? null,
        expectedResult: input.expectedResult ?? null,
        actualResult: input.actualResult ?? null,
        environment: input.environment ?? null,
        browserDevice: input.browserDevice ?? null,
        affectedReleaseId: input.affectedReleaseId ?? null,
        fixedReleaseId: input.fixedReleaseId ?? null,
        qaOwnerUserId: input.qaOwnerId ?? null,
        qaOwnerMembershipId: null,
        linkedTestCaseId: input.linkedTestCaseId ?? null,
        reopenCount: 0,
        createdByUserId: u.userId,
      };
      return { result, createdResult };
    });
    this.ticketCreation.publish(createdResult);
    this.audit.log({
      action: "bug.created",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "ticket",
      resourceId: String(result.id),
      metadata: { ticketId: result.id, projectId, title: result.title },
    });
    return result;
  }

  async updateBug(
    u: CurrentUserContext,
    projectId: number,
    bugId: number,
    input: UpdateBugInput,
  ) {
    await assertProjectWriteAccess(this.db, this.access, u, projectId);
    const existingTicket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, bugId),
        eq(tickets.orgId, u.orgId),
        eq(tickets.projectId, projectId),
        eq(tickets.type, "BUG"),
        isNull(tickets.deletedAt),
      ),
      columns: { id: true, version: true },
    });
    if (!existingTicket) throw new NotFoundException("Bug not found");
    const existingSidecar = await this.db.query.workItemQaDetails.findFirst({
      where: and(eq(workItemQaDetails.orgId, u.orgId), eq(workItemQaDetails.workItemId, bugId)),
      columns: { qaState: true, reopenCount: true },
    });
    const isReopening = input.status === "reopened" && existingSidecar?.qaState !== "reopened";
    let newTicketStatus: string | undefined;
    if (input.status !== undefined) {
      const availableStatuses = await this.db
        .select({ id: projectStatuses.id, name: projectStatuses.name, order: projectStatuses.order, type: projectStatuses.type })
        .from(projectStatuses)
        .where(and(eq(projectStatuses.orgId, u.orgId), eq(projectStatuses.projectId, projectId)));
      newTicketStatus = resolveWorkItemStatus(input.status, availableStatuses);
    }
    const ticketPriority = input.priority !== undefined ? resolveTicketPriority(input.priority) : undefined;
    await this.ticketChange.updateTicket(u, projectId, bugId, {
      version: input.version ?? existingTicket.version,
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description }),
      ...(ticketPriority !== undefined && { priority: ticketPriority }),
      ...(newTicketStatus !== undefined && { status: newTicketStatus }),
      ...(input.assigneeId !== undefined && { assigneeId: input.assigneeId }),
    });
    const sidecarSet: Record<string, unknown> = { updatedAt: new Date() };
    if (input.status !== undefined) sidecarSet["qaState"] = input.status;
    if (input.severity !== undefined) sidecarSet["severity"] = input.severity;
    if (input.stepsToReproduce !== undefined) sidecarSet["stepsToReproduce"] = input.stepsToReproduce;
    if (input.expectedResult !== undefined) sidecarSet["expectedResult"] = input.expectedResult;
    if (input.actualResult !== undefined) sidecarSet["actualResult"] = input.actualResult;
    if (input.environment !== undefined) sidecarSet["environment"] = input.environment;
    if (input.browserDevice !== undefined) sidecarSet["browserDevice"] = input.browserDevice;
    if (input.affectedReleaseId !== undefined) sidecarSet["affectedReleaseId"] = input.affectedReleaseId;
    if (input.fixedReleaseId !== undefined) sidecarSet["fixedReleaseId"] = input.fixedReleaseId;
    if (input.qaOwnerId !== undefined) sidecarSet["qaOwnerUserId"] = input.qaOwnerId;
    if (input.linkedTestCaseId !== undefined) sidecarSet["linkedTestCaseId"] = input.linkedTestCaseId;
    if (isReopening) sidecarSet["reopenCount"] = (existingSidecar?.reopenCount ?? 0) + 1;
    const [updatedSidecar] = await this.db
      .update(workItemQaDetails)
      .set(sidecarSet)
      .where(and(eq(workItemQaDetails.workItemId, bugId), eq(workItemQaDetails.orgId, u.orgId)))
      .returning();
    if (input.status !== undefined) {
      this.audit.log({
        action: "bug.status_changed",
        userId: u.userId,
        orgId: u.orgId,
        resourceType: "ticket",
        resourceId: String(bugId),
        metadata: { ticketId: bugId, projectId, from: existingSidecar?.qaState, to: input.status },
      });
    }
    const [rereadTicket] = await this.db
      .select({
        id: tickets.id,
        orgId: tickets.orgId,
        projectId: tickets.projectId,
        ticketNumber: tickets.ticketNumber,
        title: tickets.title,
        description: tickets.description,
        type: tickets.type,
        status: tickets.status,
        priority: tickets.priority,
        assigneeMembershipId: tickets.assigneeMembershipId,
        reporterId: tickets.reporterId,
        deletedAt: tickets.deletedAt,
        createdAt: tickets.createdAt,
        updatedAt: tickets.updatedAt,
        version: tickets.version,
      })
      .from(tickets)
      .where(and(eq(tickets.id, bugId), eq(tickets.orgId, u.orgId), isNull(tickets.deletedAt)))
      .limit(1);
    if (!rereadTicket) throw new NotFoundException("Bug not found after update");
    return {
      ...rereadTicket,
      qaState: updatedSidecar?.qaState ?? existingSidecar?.qaState ?? null,
      severity: updatedSidecar?.severity ?? null,
      stepsToReproduce: updatedSidecar?.stepsToReproduce ?? null,
      expectedResult: updatedSidecar?.expectedResult ?? null,
      actualResult: updatedSidecar?.actualResult ?? null,
      environment: updatedSidecar?.environment ?? null,
      browserDevice: updatedSidecar?.browserDevice ?? null,
      affectedReleaseId: updatedSidecar?.affectedReleaseId ?? null,
      fixedReleaseId: updatedSidecar?.fixedReleaseId ?? null,
      qaOwnerUserId: updatedSidecar?.qaOwnerUserId ?? null,
      qaOwnerMembershipId: updatedSidecar?.qaOwnerMembershipId ?? null,
      linkedTestCaseId: updatedSidecar?.linkedTestCaseId ?? null,
      reopenCount: updatedSidecar?.reopenCount ?? existingSidecar?.reopenCount ?? 0,
      createdByUserId: updatedSidecar?.createdByUserId ?? null,
    };
  }

  async deleteBug(u: CurrentUserContext, projectId: number, bugId: number) {
    await assertProjectWriteAccess(this.db, this.access, u, projectId);
    const existing = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, bugId),
        eq(tickets.orgId, u.orgId),
        eq(tickets.projectId, projectId),
        eq(tickets.type, "BUG"),
        isNull(tickets.deletedAt),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Bug not found");
    await this.ticketDelete.deleteTicket(u, projectId, bugId, false);
    return { success: true };
  }
}
