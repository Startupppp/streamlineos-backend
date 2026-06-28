import { Inject, Injectable } from "@nestjs/common";
import { and, avg, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import {
  okrGoals,
  okrKeyResults,
  okrLinks,
  okrUpdates,
  projects,
  tickets,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import { resolveGoalsScope } from "./goals-scope";
import type {
  CheckInInput,
  CreateInput,
  CreateKeyResultInput,
  CreateLinkInput,
  ListInput,
  UpdateInput,
  UpdateKeyResultInput,
} from "./dto/goal.schemas";

type GoalStatus =
  | "not_started"
  | "on_track"
  | "at_risk"
  | "off_track"
  | "completed";

const STATUS_KEYS: GoalStatus[] = [
  "not_started",
  "on_track",
  "at_risk",
  "off_track",
  "completed",
];

interface GoalStats {
  total: number;
  byStatus: Record<GoalStatus, number>;
  avgProgress: number;
  atRisk: number;
  completed: number;
}

interface GoalOwner {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

interface GoalProject {
  id: number;
  name: string;
  key: string;
}

export interface GoalLinkRow {
  id: number;
  ticketId: number | null;
  projectId: number | null;
  createdAt: Date;
  ticketTitle: string | null;
  ticketProjectId: number | null;
  projectName: string | null;
  projectKey: string | null;
}

interface GoalUpdateRow {
  id: number;
  keyResultId: number | null;
  note: string | null;
  previousValue: string | null;
  newValue: string;
  createdAt: Date;
  userId: string;
  userName: string | null;
  userImage: string | null;
}

type GoalListItem = typeof okrGoals.$inferSelect & { owner: GoalOwner | null; keyResultCount: number };

type GoalDetail = typeof okrGoals.$inferSelect & {
  owner: GoalOwner | null;
  project: GoalProject | null;
  keyResults: Array<typeof okrKeyResults.$inferSelect>;
  updates: GoalUpdateRow[];
  links: GoalLinkRow[];
};

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function keyResultPercent(kr: {
  metricType: "number" | "percentage" | "currency" | "boolean";
  startValue: string;
  targetValue: string;
  currentValue: string;
}): number {
  if (kr.metricType === "boolean") {
    return parseFloat(kr.currentValue) >= 1 ? 100 : 0;
  }
  const start = parseFloat(kr.startValue);
  const target = parseFloat(kr.targetValue);
  const current = parseFloat(kr.currentValue);
  const denominator = target - start;
  if (denominator === 0) {
    return current >= target ? 100 : 0;
  }
  return clamp(((current - start) / denominator) * 100, 0, 100);
}

@Injectable()
export class GoalsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  private recomputeGoalProgress(
    goalId: number,
    orgId: string,
  ): Promise<number | null> {
    return this.db.transaction(async (tx) => {
      const keyResults = await tx.query.okrKeyResults.findMany({
        where: and(
          eq(okrKeyResults.goalId, goalId),
          eq(okrKeyResults.orgId, orgId),
        ),
        columns: {
          metricType: true,
          startValue: true,
          targetValue: true,
          currentValue: true,
        },
      });

      if (keyResults.length === 0) {
        return null;
      }

      const total = keyResults.reduce(
        (sum, kr) => sum + keyResultPercent(kr),
        0,
      );
      const progress = Math.round(total / keyResults.length);

      await tx
        .update(okrGoals)
        .set({ progress, updatedAt: new Date() })
        .where(and(eq(okrGoals.id, goalId), eq(okrGoals.orgId, orgId)));

      return progress;
    });
  }

  async list(u: CurrentUserContext, filters: ListInput): Promise<GoalListItem[]> {
    const { orgId, userId } = u;
    const scope = await resolveGoalsScope(this.access, u);

    const conditions: ReturnType<typeof and>[] = [eq(okrGoals.orgId, orgId)];

    if (scope !== "all") {
      const ownershipFilter = or(eq(okrGoals.ownerId, userId), eq(okrGoals.createdBy, userId));
      if (ownershipFilter) conditions.push(ownershipFilter);
    }

    if (filters.status) conditions.push(eq(okrGoals.status, filters.status));
    if (filters.level) conditions.push(eq(okrGoals.level, filters.level));
    if (filters.ownerId) conditions.push(eq(okrGoals.ownerId, filters.ownerId));
    if (filters.projectId !== undefined)
      conditions.push(eq(okrGoals.projectId, filters.projectId));
    if (filters.search)
      conditions.push(ilike(okrGoals.title, `%${filters.search}%`));

    const limit = Math.min(filters.limit, 100);
    const offset = (filters.page - 1) * limit;

    const goals = await this.db.query.okrGoals.findMany({
      where: and(...conditions),
      orderBy: [desc(okrGoals.createdAt)],
      with: {
        owner: { columns: { id: true, name: true, email: true, image: true } },
      },
      limit,
      offset,
    });

    if (goals.length === 0) return [];

    const goalIds = goals.map((g) => g.id);
    const counts = await this.db
      .select({ goalId: okrKeyResults.goalId, total: count() })
      .from(okrKeyResults)
      .where(and(eq(okrKeyResults.orgId, orgId), inArray(okrKeyResults.goalId, goalIds)))
      .groupBy(okrKeyResults.goalId);

    const countMap = new Map(counts.map((c) => [c.goalId, c.total]));

    return goals.map((goal) => ({
      ...goal,
      keyResultCount: countMap.get(goal.id) ?? 0,
    }));
  }

  create(orgId: string, userId: string, input: CreateInput): Promise<typeof okrGoals.$inferSelect> {
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(okrGoals)
        .values({
          orgId,
          title: input.title,
          description: input.description ?? null,
          ownerId: input.ownerId ?? null,
          level: input.level,
          status: input.status,
          startDate: input.startDate ?? null,
          dueDate: input.dueDate ?? null,
          parentGoalId: input.parentGoalId ?? null,
          projectId: input.projectId ?? null,
          createdBy: userId,
        })
        .returning();

      if (input.keyResults && input.keyResults.length > 0) {
        await tx.insert(okrKeyResults).values(
          input.keyResults.map((kr) => ({
            orgId,
            goalId: created.id,
            title: kr.title,
            metricType: kr.metricType,
            startValue: kr.startValue.toString(),
            targetValue: kr.targetValue.toString(),
            currentValue: kr.currentValue.toString(),
            unit: kr.unit ?? null,
          })),
        );
      }

      return created;
    });
  }

  async getStats(orgId: string): Promise<GoalStats> {
    const rows = await this.db
      .select({
        status: okrGoals.status,
        statusCount: count(),
        avgProgress: avg(okrGoals.progress),
      })
      .from(okrGoals)
      .where(eq(okrGoals.orgId, orgId))
      .groupBy(okrGoals.status);

    const byStatus = STATUS_KEYS.reduce<Record<GoalStatus, number>>(
      (acc, key) => {
        acc[key] = 0;
        return acc;
      },
      { not_started: 0, on_track: 0, at_risk: 0, off_track: 0, completed: 0 },
    );

    let total = 0;
    let progressSum = 0;
    for (const row of rows) {
      byStatus[row.status] = row.statusCount;
      total += row.statusCount;
      progressSum += parseFloat(row.avgProgress ?? "0") * row.statusCount;
    }

    const avgProgress = total > 0 ? Math.round(progressSum / total) : 0;

    return {
      total,
      byStatus,
      avgProgress,
      atRisk: byStatus.at_risk + byStatus.off_track,
      completed: byStatus.completed,
    };
  }

  async getGoal(orgId: string, goalId: number): Promise<GoalDetail | null> {
    const goal = await this.db.query.okrGoals.findFirst({
      where: and(eq(okrGoals.id, goalId), eq(okrGoals.orgId, orgId)),
      with: {
        owner: { columns: { id: true, name: true, email: true, image: true } },
        project: { columns: { id: true, name: true, key: true } },
      },
    });
    if (!goal) return null;

    const keyResults = await this.db.query.okrKeyResults.findMany({
      where: and(
        eq(okrKeyResults.goalId, goalId),
        eq(okrKeyResults.orgId, orgId),
      ),
      orderBy: [okrKeyResults.id],
    });

    const updates = await this.db
      .select({
        id: okrUpdates.id,
        keyResultId: okrUpdates.keyResultId,
        note: okrUpdates.note,
        previousValue: okrUpdates.previousValue,
        newValue: okrUpdates.newValue,
        createdAt: okrUpdates.createdAt,
        userId: okrUpdates.userId,
        userName: users.name,
        userImage: users.image,
      })
      .from(okrUpdates)
      .leftJoin(users, eq(okrUpdates.userId, users.id))
      .where(and(eq(okrUpdates.goalId, goalId), eq(okrUpdates.orgId, orgId)))
      .orderBy(desc(okrUpdates.createdAt))
      .limit(20);

    const links = await this.getLinks(orgId, goalId);

    return { ...goal, keyResults, updates, links };
  }

  async update(orgId: string, goalId: number, input: UpdateInput): Promise<typeof okrGoals.$inferSelect | null> {
    const [updated] = await this.db
      .update(okrGoals)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(okrGoals.id, goalId), eq(okrGoals.orgId, orgId)))
      .returning();

    if (!updated) return null;
    return updated;
  }

  async remove(orgId: string, goalId: number): Promise<{ success: true } | null> {
    const [deleted] = await this.db
      .delete(okrGoals)
      .where(and(eq(okrGoals.id, goalId), eq(okrGoals.orgId, orgId)))
      .returning();

    if (!deleted) return null;
    return { success: true };
  }

  async checkIn(
    orgId: string,
    userId: string,
    goalId: number,
    input: CheckInInput,
  ): Promise<typeof okrGoals.$inferSelect | null> {
    const keyResult = await this.db.query.okrKeyResults.findFirst({
      where: and(
        eq(okrKeyResults.id, input.keyResultId),
        eq(okrKeyResults.goalId, goalId),
        eq(okrKeyResults.orgId, orgId),
      ),
      columns: { id: true, currentValue: true },
    });
    if (!keyResult) return null;

    const previousValue = keyResult.currentValue;
    const newValue = input.newValue.toString();

    await this.db.transaction(async (tx) => {
      await tx
        .update(okrKeyResults)
        .set({ currentValue: newValue, updatedAt: new Date() })
        .where(
          and(
            eq(okrKeyResults.id, input.keyResultId),
            eq(okrKeyResults.orgId, orgId),
          ),
        );

      await tx.insert(okrUpdates).values({
        orgId,
        goalId,
        keyResultId: input.keyResultId,
        note: input.note ?? null,
        previousValue,
        newValue,
        userId,
      });
    });

    await this.recomputeGoalProgress(goalId, orgId);

    const goal = await this.db.query.okrGoals.findFirst({
      where: and(eq(okrGoals.id, goalId), eq(okrGoals.orgId, orgId)),
    });

    return goal;
  }

  listKeyResults(orgId: string, goalId: number): Promise<Array<typeof okrKeyResults.$inferSelect>> {
    return this.db.query.okrKeyResults.findMany({
      where: and(
        eq(okrKeyResults.goalId, goalId),
        eq(okrKeyResults.orgId, orgId),
      ),
      orderBy: [okrKeyResults.id],
    });
  }

  async createKeyResult(
    orgId: string,
    goalId: number,
    input: CreateKeyResultInput,
  ): Promise<typeof okrKeyResults.$inferSelect | null> {
    const goal = await this.db.query.okrGoals.findFirst({
      where: and(eq(okrGoals.id, goalId), eq(okrGoals.orgId, orgId)),
      columns: { id: true },
    });
    if (!goal) return null;

    const [keyResult] = await this.db
      .insert(okrKeyResults)
      .values({
        orgId,
        goalId,
        title: input.title,
        metricType: input.metricType,
        startValue: input.startValue.toString(),
        targetValue: input.targetValue.toString(),
        currentValue: input.currentValue.toString(),
        unit: input.unit ?? null,
        status: input.status,
      })
      .returning();

    await this.recomputeGoalProgress(goalId, orgId);

    return keyResult;
  }

  async updateKeyResult(
    orgId: string,
    keyResultId: number,
    input: UpdateKeyResultInput,
  ): Promise<typeof okrKeyResults.$inferSelect | null> {
    const existing = await this.db.query.okrKeyResults.findFirst({
      where: and(
        eq(okrKeyResults.id, keyResultId),
        eq(okrKeyResults.orgId, orgId),
      ),
      columns: { id: true, goalId: true },
    });
    if (!existing) return null;

    const patch: Partial<typeof okrKeyResults.$inferInsert> & { updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (input.title !== undefined) patch.title = input.title;
    if (input.metricType !== undefined) patch.metricType = input.metricType;
    if (input.startValue !== undefined) patch.startValue = input.startValue.toString();
    if (input.targetValue !== undefined) patch.targetValue = input.targetValue.toString();
    if (input.currentValue !== undefined) patch.currentValue = input.currentValue.toString();
    if (input.unit !== undefined) patch.unit = input.unit;
    if (input.status !== undefined) patch.status = input.status;

    const [updated] = await this.db
      .update(okrKeyResults)
      .set(patch)
      .where(
        and(eq(okrKeyResults.id, keyResultId), eq(okrKeyResults.orgId, orgId)),
      )
      .returning();

    await this.recomputeGoalProgress(existing.goalId, orgId);

    return updated ?? null;
  }

  async removeKeyResult(orgId: string, keyResultId: number): Promise<{ success: true } | null> {
    const existing = await this.db.query.okrKeyResults.findFirst({
      where: and(
        eq(okrKeyResults.id, keyResultId),
        eq(okrKeyResults.orgId, orgId),
      ),
      columns: { id: true, goalId: true },
    });
    if (!existing) return null;

    await this.db
      .delete(okrKeyResults)
      .where(
        and(eq(okrKeyResults.id, keyResultId), eq(okrKeyResults.orgId, orgId)),
      );

    await this.recomputeGoalProgress(existing.goalId, orgId);

    return { success: true };
  }

  getLinks(orgId: string, goalId: number): Promise<GoalLinkRow[]> {
    return this.db
      .select({
        id: okrLinks.id,
        ticketId: okrLinks.ticketId,
        projectId: okrLinks.projectId,
        createdAt: okrLinks.createdAt,
        ticketTitle: tickets.title,
        ticketProjectId: tickets.projectId,
        projectName: projects.name,
        projectKey: projects.key,
      })
      .from(okrLinks)
      .leftJoin(tickets, eq(okrLinks.ticketId, tickets.id))
      .leftJoin(projects, eq(okrLinks.projectId, projects.id))
      .where(and(eq(okrLinks.goalId, goalId), eq(okrLinks.orgId, orgId)))
      .orderBy(desc(okrLinks.createdAt))
      .limit(100);
  }

  async createLink(orgId: string, goalId: number, input: CreateLinkInput): Promise<CreateLinkResult> {
    const goal = await this.db.query.okrGoals.findFirst({
      where: and(eq(okrGoals.id, goalId), eq(okrGoals.orgId, orgId)),
      columns: { id: true },
    });
    if (!goal) return { error: "goal_not_found" as const };

    if (input.ticketId !== undefined) {
      const ticket = await this.db.query.tickets.findFirst({
        where: and(eq(tickets.id, input.ticketId), eq(tickets.orgId, orgId)),
        columns: { id: true },
      });
      if (!ticket) return { error: "ticket_not_found" as const };
    }

    if (input.projectId !== undefined) {
      const project = await this.db.query.projects.findFirst({
        where: and(eq(projects.id, input.projectId), eq(projects.orgId, orgId)),
        columns: { id: true },
      });
      if (!project) return { error: "project_not_found" as const };
    }

    const [link] = await this.db
      .insert(okrLinks)
      .values({
        orgId,
        goalId,
        ticketId: input.ticketId ?? null,
        projectId: input.projectId ?? null,
      })
      .returning();

    return link;
  }

  async removeLink(orgId: string, goalId: number, linkId: number): Promise<{ success: true } | null> {
    const [deleted] = await this.db
      .delete(okrLinks)
      .where(
        and(
          eq(okrLinks.id, linkId),
          eq(okrLinks.goalId, goalId),
          eq(okrLinks.orgId, orgId),
        ),
      )
      .returning();

    if (!deleted) return null;
    return { success: true };
  }
}

export type CreateLinkResult =
  | typeof okrLinks.$inferSelect
  | { error: "goal_not_found" }
  | { error: "ticket_not_found" }
  | { error: "project_not_found" };

export function isLinkGoalNotFound(
  result: CreateLinkResult,
): result is { error: "goal_not_found" } {
  return (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    result.error === "goal_not_found"
  );
}

export function isLinkTicketNotFound(
  result: CreateLinkResult,
): result is { error: "ticket_not_found" } {
  return (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    result.error === "ticket_not_found"
  );
}

export function isLinkProjectNotFound(
  result: CreateLinkResult,
): result is { error: "project_not_found" } {
  return (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    result.error === "project_not_found"
  );
}
