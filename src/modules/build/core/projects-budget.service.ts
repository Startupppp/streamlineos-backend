import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sum } from "drizzle-orm";
import { projectMembers, projects, tickets, timesheets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { UpdateBudgetInput } from "./dto/projects.schemas";

export interface MemberCost {
  userId: string;
  hours: number;
  cost: number;
}

@Injectable()
export class ProjectsBudgetService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  private async assertProjectAccess(
    u: CurrentUserContext,
    projectId: number,
  ): Promise<{ id: number; budget: string | null }> {
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    const isOwnerOrAdmin = perms.has("build:manage");
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
    const memberIds = [...memberRates.keys()];

    const [hoursPerMemberRows, totalHoursResult] = await Promise.all([
      memberIds.length > 0
        ? this.db
            .select({ userId: timesheets.userId, hours: sum(timesheets.hours) })
            .from(timesheets)
            .innerJoin(tickets, eq(timesheets.ticketId, tickets.id))
            .where(
              and(
                eq(timesheets.orgId, orgId),
                eq(tickets.projectId, projectId),
                eq(timesheets.isBillable, true),
                inArray(timesheets.userId, memberIds),
              ),
            )
            .groupBy(timesheets.userId)
        : Promise.resolve([] as Array<{ userId: string | null; hours: string | null }>),
      this.db
        .select({ value: sum(timesheets.hours) })
        .from(timesheets)
        .innerJoin(tickets, eq(timesheets.ticketId, tickets.id))
        .where(
          and(
            eq(timesheets.orgId, orgId),
            eq(tickets.projectId, projectId),
            eq(timesheets.isBillable, true),
          ),
        ),
    ]);

    const hoursByUser = new Map<string, number>(
      hoursPerMemberRows
        .filter((r): r is { userId: string; hours: string | null } => r.userId !== null)
        .map((r) => [r.userId, Number(r.hours ?? 0)]),
    );

    const memberCosts: MemberCost[] = [];
    for (const [userId, rate] of memberRates) {
      const hours = hoursByUser.get(userId) ?? 0;
      memberCosts.push({ userId, hours, cost: hours * rate });
    }

    const actualCost = memberCosts.reduce((acc, m) => acc + m.cost, 0);
    const plannedBudget = Number(project.budget ?? 0);
    const totalHours = Number(totalHoursResult[0]?.value ?? 0);

    return {
      projectId,
      plannedBudget,
      actualCost,
      remaining: plannedBudget - actualCost,
      utilizationPct: plannedBudget > 0 ? Math.round((actualCost / plannedBudget) * 100) : 0,
      totalHours,
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
