import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, or } from "drizzle-orm";
import { organizationMembers, projectStatuses, workflowTransitions } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { assertProjectAccess, assertProjectWriteAccess } from "../core";
import type { CreateTransitionInput, UpdateTransitionInput, WipLimitInput } from "./dto/workflow.schemas";

type TransitionPatch = Partial<Pick<typeof workflowTransitions.$inferInsert,
  "fromStatusId" | "toStatusId" | "name" | "requiresApproval" | "requiredFields" | "allowedRoles">>;

@Injectable()
export class WorkflowService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  private async assertStatusInProject(orgId: string, projectId: number, statusId: number): Promise<void> {
    const s = await this.db.query.projectStatuses.findFirst({
      where: and(
        eq(projectStatuses.id, statusId),
        eq(projectStatuses.projectId, projectId),
        eq(projectStatuses.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!s) throw new NotFoundException("Status not found");
  }

  private async loadTransition(orgId: string, projectId: number, transitionId: number) {
    const [row] = await this.db
      .select()
      .from(workflowTransitions)
      .where(and(
        eq(workflowTransitions.id, transitionId),
        eq(workflowTransitions.orgId, orgId),
        eq(workflowTransitions.projectId, projectId),
        isNull(workflowTransitions.deletedAt),
      ))
      .limit(1);
    if (!row) throw new NotFoundException("Transition not found");
    return row;
  }

  async listTransitions(u: CurrentUserContext, projectId: number) {
    const { orgId } = u;
    await assertProjectAccess(this.db, this.access, u, projectId);
    return this.db
      .select()
      .from(workflowTransitions)
      .where(and(
        eq(workflowTransitions.orgId, orgId),
        eq(workflowTransitions.projectId, projectId),
        isNull(workflowTransitions.deletedAt),
      ))
      .limit(100);
  }

  async createTransition(u: CurrentUserContext, projectId: number, input: CreateTransitionInput) {
    const { orgId, userId } = u;
    await assertProjectWriteAccess(this.db, this.access, u, projectId);
    await this.assertStatusInProject(orgId, projectId, input.toStatusId);
    if (input.fromStatusId != null) {
      await this.assertStatusInProject(orgId, projectId, input.fromStatusId);
    }
    const [membership] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);
    const [transition] = await this.db
      .insert(workflowTransitions)
      .values({
        orgId,
        projectId,
        fromStatusId: input.fromStatusId ?? null,
        toStatusId: input.toStatusId,
        name: input.name ?? null,
        requiresApproval: input.requiresApproval ?? false,
        requiredFields: input.requiredFields ?? [],
        allowedRoles: input.allowedRoles ?? [],
        createdByMembershipId: membership?.id ?? null,
      })
      .returning();
    if (!transition) throw new NotFoundException("Failed to create transition");
    this.audit.log({
      action: "workflow.transition_created",
      userId,
      orgId,
      resourceType: "workflow_transition",
      resourceId: String(transition.id),
      metadata: { projectId, transitionId: transition.id },
    });
    return transition;
  }

  async updateTransition(
    u: CurrentUserContext,
    projectId: number,
    transitionId: number,
    input: UpdateTransitionInput,
  ) {
    const { orgId, userId } = u;
    await assertProjectWriteAccess(this.db, this.access, u, projectId);
    await this.loadTransition(orgId, projectId, transitionId);
    const patch: TransitionPatch = {};
    if (input.fromStatusId !== undefined) {
      if (input.fromStatusId !== null) {
        await this.assertStatusInProject(orgId, projectId, input.fromStatusId);
      }
      patch.fromStatusId = input.fromStatusId;
    }
    if (input.toStatusId !== undefined) {
      await this.assertStatusInProject(orgId, projectId, input.toStatusId);
      patch.toStatusId = input.toStatusId;
    }
    if (input.name !== undefined) patch.name = input.name ?? null;
    if (input.requiresApproval !== undefined) patch.requiresApproval = input.requiresApproval;
    if (input.requiredFields !== undefined) patch.requiredFields = input.requiredFields;
    if (input.allowedRoles !== undefined) patch.allowedRoles = input.allowedRoles;
    const [updated] = await this.db
      .update(workflowTransitions)
      .set(patch)
      .where(and(
        eq(workflowTransitions.id, transitionId),
        eq(workflowTransitions.orgId, orgId),
        eq(workflowTransitions.projectId, projectId),
      ))
      .returning();
    if (!updated) throw new NotFoundException("Transition not found");
    this.audit.log({
      action: "workflow.transition_updated",
      userId,
      orgId,
      resourceType: "workflow_transition",
      resourceId: String(transitionId),
      metadata: { projectId, transitionId },
    });
    return updated;
  }

  async deleteTransition(u: CurrentUserContext, projectId: number, transitionId: number) {
    const { orgId, userId } = u;
    await assertProjectWriteAccess(this.db, this.access, u, projectId);
    await this.loadTransition(orgId, projectId, transitionId);
    await this.db
      .update(workflowTransitions)
      .set({ deletedAt: new Date() })
      .where(and(
        eq(workflowTransitions.id, transitionId),
        eq(workflowTransitions.orgId, orgId),
        eq(workflowTransitions.projectId, projectId),
      ));
    this.audit.log({
      action: "workflow.transition_deleted",
      userId,
      orgId,
      resourceType: "workflow_transition",
      resourceId: String(transitionId),
      metadata: { projectId, transitionId },
    });
  }

  async getAllowedTransitions(u: CurrentUserContext, projectId: number, fromStatusId: number) {
    const { orgId } = u;
    await assertProjectAccess(this.db, this.access, u, projectId);
    return this.db
      .select()
      .from(workflowTransitions)
      .where(and(
        eq(workflowTransitions.orgId, orgId),
        eq(workflowTransitions.projectId, projectId),
        isNull(workflowTransitions.deletedAt),
        or(
          eq(workflowTransitions.fromStatusId, fromStatusId),
          isNull(workflowTransitions.fromStatusId),
        ),
      ))
      .limit(100);
  }

  async updateWipLimit(u: CurrentUserContext, projectId: number, statusId: number, input: WipLimitInput) {
    const { orgId, userId } = u;
    await assertProjectWriteAccess(this.db, this.access, u, projectId);
    await this.assertStatusInProject(orgId, projectId, statusId);
    const [updated] = await this.db
      .update(projectStatuses)
      .set({ wipLimit: input.wipLimit })
      .where(and(
        eq(projectStatuses.id, statusId),
        eq(projectStatuses.orgId, orgId),
        eq(projectStatuses.projectId, projectId),
      ))
      .returning();
    if (!updated) throw new NotFoundException("Status not found");
    this.audit.log({
      action: "workflow.wip_updated",
      userId,
      orgId,
      resourceType: "project_status",
      resourceId: String(statusId),
      metadata: { projectId, statusId, wipLimit: input.wipLimit },
    });
    return updated;
  }
}
