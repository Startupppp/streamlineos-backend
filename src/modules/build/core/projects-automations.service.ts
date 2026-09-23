import { Injectable, Inject, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { and, eq, desc, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { projectAutomations, projectStatuses } from "../../../db/schema";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { ProjectsMembersService } from "./projects-members.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CreateAutomationInput, UpdateAutomationInput } from "./dto/automation.schemas";

@Injectable()
export class ProjectsAutomationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly planLimits: PlanLimitsService,
    private readonly members: ProjectsMembersService,
  ) {}

  private async assertSetStatusActionsValid(
    orgId: string,
    projectId: number,
    actions: CreateAutomationInput["actions"],
  ): Promise<void> {
    const statusValues = [...new Set(
      actions.filter((a) => a.type === "set_status").map((a) => a.value),
    )];
    if (statusValues.length === 0) return;

    const existing = await this.db
      .select({ name: projectStatuses.name })
      .from(projectStatuses)
      .where(
        and(
          eq(projectStatuses.orgId, orgId),
          eq(projectStatuses.projectId, projectId),
          inArray(projectStatuses.name, statusValues),
        ),
      );

    const existingNames = new Set(existing.map((r) => r.name));
    const missing = statusValues.filter((v) => !existingNames.has(v));
    if (missing.length > 0)
      throw new UnprocessableEntityException(
        `Status ${missing.map((s) => `"${s}"`).join(", ")} does not exist in this project`,
      );
  }

  async listAutomations(u: CurrentUserContext, projectId: number) {
    await this.members.assertProjectAccess(u, projectId);
    return this.db
      .select({
        id: projectAutomations.id,
        projectId: projectAutomations.projectId,
        name: projectAutomations.name,
        triggerEvent: projectAutomations.triggerEvent,
        isActive: projectAutomations.isActive,
        conditions: projectAutomations.conditions,
        actions: projectAutomations.actions,
        createdAt: projectAutomations.createdAt,
        updatedAt: projectAutomations.updatedAt,
      })
      .from(projectAutomations)
      .where(and(eq(projectAutomations.orgId, u.orgId), eq(projectAutomations.projectId, projectId)))
      .orderBy(desc(projectAutomations.createdAt))
      .limit(100);
  }

  async createAutomation(u: CurrentUserContext, projectId: number, data: CreateAutomationInput) {
    await this.members.assertCanManageProject(u, projectId);
    await this.planLimits.assertWithinLimit(u.orgId, "automations");
    await this.assertSetStatusActionsValid(u.orgId, projectId, data.actions);

    const [automation] = await this.db
      .insert(projectAutomations)
      .values({ orgId: u.orgId, projectId, createdBy: u.userId, ...data })
      .returning();
    return automation;
  }

  async updateAutomation(u: CurrentUserContext, projectId: number, automationId: number, data: UpdateAutomationInput) {
    await this.members.assertCanManageProject(u, projectId);
    if (data.actions !== undefined)
      await this.assertSetStatusActionsValid(u.orgId, projectId, data.actions);

    const [updated] = await this.db
      .update(projectAutomations)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(projectAutomations.id, automationId),
          eq(projectAutomations.orgId, u.orgId),
          eq(projectAutomations.projectId, projectId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Automation not found");
    return updated;
  }

  async deleteAutomation(u: CurrentUserContext, projectId: number, automationId: number) {
    await this.members.assertCanManageProject(u, projectId);
    const [deleted] = await this.db
      .delete(projectAutomations)
      .where(
        and(
          eq(projectAutomations.id, automationId),
          eq(projectAutomations.orgId, u.orgId),
          eq(projectAutomations.projectId, projectId),
        ),
      )
      .returning();
    if (!deleted) throw new NotFoundException("Automation not found");
  }
}
