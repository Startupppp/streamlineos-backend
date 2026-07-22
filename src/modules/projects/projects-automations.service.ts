import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { and, eq, desc } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { projectAutomations } from "../../db/schema";
import { PlanLimitsService } from "../billing/plan-limits.service";
import { ProjectsMembersService } from "./projects-members.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { CreateAutomationInput, UpdateAutomationInput } from "./dto/automation.schemas";

@Injectable()
export class ProjectsAutomationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly planLimits: PlanLimitsService,
    private readonly members: ProjectsMembersService,
  ) {}

  listAutomations(orgId: string, projectId: number) {
    return this.db
      .select({
        id: projectAutomations.id,
        name: projectAutomations.name,
        triggerEvent: projectAutomations.triggerEvent,
        isActive: projectAutomations.isActive,
        createdAt: projectAutomations.createdAt,
        updatedAt: projectAutomations.updatedAt,
      })
      .from(projectAutomations)
      .where(and(eq(projectAutomations.orgId, orgId), eq(projectAutomations.projectId, projectId)))
      .orderBy(desc(projectAutomations.createdAt))
      .limit(100);
  }

  async createAutomation(u: CurrentUserContext, projectId: number, data: CreateAutomationInput) {
    await this.members.assertCanManageProject(u, projectId);
    await this.planLimits.assertWithinLimit(u.orgId, "automations");

    const [automation] = await this.db
      .insert(projectAutomations)
      .values({ orgId: u.orgId, projectId, createdBy: u.userId, ...data })
      .returning();
    return automation;
  }

  async updateAutomation(u: CurrentUserContext, projectId: number, automationId: number, data: UpdateAutomationInput) {
    await this.members.assertCanManageProject(u, projectId);
    const [updated] = await this.db
      .update(projectAutomations)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(projectAutomations.id, automationId), eq(projectAutomations.orgId, u.orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Automation not found");
    return updated;
  }

  async deleteAutomation(u: CurrentUserContext, projectId: number, automationId: number) {
    await this.members.assertCanManageProject(u, projectId);
    const [deleted] = await this.db
      .delete(projectAutomations)
      .where(and(eq(projectAutomations.id, automationId), eq(projectAutomations.orgId, u.orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Automation not found");
  }
}
