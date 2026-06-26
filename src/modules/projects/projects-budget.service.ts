import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sum } from "drizzle-orm";
import { projectMembers, projects, timesheets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { UpdateBudgetInput } from "./dto/projects.schemas";

export interface MemberCost {
  userId: string;
  hours: number;
  cost: number;
}

@Injectable()
export class ProjectsBudgetService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async assertProjectAccess(
    u: CurrentUserContext,
    projectId: number,
  ): Promise<{ id: number; budget: string | null }> {
    const isOwnerOrAdmin = defineAbilityFor(u).can("manage", "projects");
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, u.orgId)),
      columns: { id: true, budget: true, managerId: true },
    });
    if (!project) throw new NotFoundException("Project not found");

    if (!isOwnerOrAdmin && project.managerId !== u.userId) {
      const memberOf = await this.db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(and(eq(projectMembers.userId, u.userId), eq(projectMembers.projectId, projectId)));
      if (memberOf.length === 0) throw new NotFoundException("Not found");
    }

    return { id: project.id, budget: project.budget };
  }

  async getBudget(u: CurrentUserContext, projectId: number) {
    const project = await this.assertProjectAccess(u, projectId);
    const orgId = u.orgId;

    const members = await this.db.query.projectMembers.findMany({
      where: eq(projectMembers.projectId, projectId),
      columns: { userId: true, hourlyRate: true },
    });

    const memberRates = new Map(
      members.map((m): [string, number] => [m.userId, Number(m.hourlyRate ?? 0)]),
    );

    const [{ value: totalHours }] = await this.db
      .select({ value: sum(timesheets.hours) })
      .from(timesheets)
      .where(and(eq(timesheets.orgId, orgId), eq(timesheets.isBillable, true)));

    const memberCosts: MemberCost[] = [];
    for (const [userId, rate] of memberRates) {
      const [{ value: hrs }] = await this.db
        .select({ value: sum(timesheets.hours) })
        .from(timesheets)
        .where(
          and(
            eq(timesheets.orgId, orgId),
            eq(timesheets.userId, userId),
            eq(timesheets.isBillable, true),
          ),
        );
      const hours = Number(hrs ?? 0);
      memberCosts.push({ userId, hours, cost: hours * rate });
    }

    const actualCost = memberCosts.reduce((acc, m) => acc + m.cost, 0);
    const plannedBudget = Number(project.budget ?? 0);

    return {
      projectId,
      plannedBudget,
      actualCost,
      remaining: plannedBudget - actualCost,
      utilizationPct: plannedBudget > 0 ? Math.round((actualCost / plannedBudget) * 100) : 0,
      totalHours: Number(totalHours ?? 0),
      memberBreakdown: memberCosts,
    };
  }

  async updateBudget(u: CurrentUserContext, projectId: number, input: UpdateBudgetInput) {
    await this.assertProjectAccess(u, projectId);

    const [updated] = await this.db
      .update(projects)
      .set({ budget: String(input.budget) })
      .where(and(eq(projects.id, projectId), eq(projects.orgId, u.orgId)))
      .returning({ id: projects.id, budget: projects.budget });

    if (!updated) throw new NotFoundException("Project not found");
    return updated;
  }
}
