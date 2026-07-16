import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { and, eq, desc } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { projectAutomations } from "../../db/schema";
import { PlanLimitsService } from "../billing/plan-limits.service";
import type { CreateAutomationInput, UpdateAutomationInput } from "./dto/automation.schemas";

@Injectable()
export class ProjectsAutomationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly planLimits: PlanLimitsService,
  ) {}

  listAutomations(orgId: string, projectId: number) {
    return this.db
      .select()
      .from(projectAutomations)
      .where(and(eq(projectAutomations.orgId, orgId), eq(projectAutomations.projectId, projectId)))
      .orderBy(desc(projectAutomations.createdAt));
  }

  async createAutomation(orgId: string, projectId: number, createdBy: string, data: CreateAutomationInput) {
    await this.planLimits.assertWithinLimit(orgId, "automations");

    const [automation] = await this.db
      .insert(projectAutomations)
      .values({ orgId, projectId, createdBy, ...data })
      .returning();
    return automation;
  }

  async updateAutomation(orgId: string, automationId: number, data: UpdateAutomationInput) {
    const [updated] = await this.db
      .update(projectAutomations)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(projectAutomations.id, automationId), eq(projectAutomations.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Automation not found");
    return updated;
  }

  async deleteAutomation(orgId: string, automationId: number) {
    const [deleted] = await this.db
      .delete(projectAutomations)
      .where(and(eq(projectAutomations.id, automationId), eq(projectAutomations.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Automation not found");
  }
}
