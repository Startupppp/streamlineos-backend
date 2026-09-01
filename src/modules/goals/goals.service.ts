import { Inject, Injectable } from "@nestjs/common";
import { and, avg, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import {
  okrGoals,
  okrKeyResults,
  okrUpdates,
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { actingMembershipId } from "../../common/auth/principal";
import { AccessService } from "../access/access.service";
import { resolveGoalsScope } from "./goals-scope";
import type {
  CheckInInput,
  CreateInput,
  ListInput,
  UpdateInput,
} from "./dto/goal.schemas";
import { GoalLinksService, type GoalLinkRow } from "./goal-links.service";

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

export interface GoalStats {
  total: number;
  byStatus: Record<GoalStatus, number>;
  avgProgress: number;
  atRisk: number;
  completed: number;
}

export interface GoalOwner {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

export interface GoalProject {
  id: number;
  name: string;
  key: string;
}

export interface GoalUpdateRow {
  id: number;
  keyResultId: number | null;
  note: string | null;
  previousValue: string | null;
  newValue: string | null;
  createdAt: Date;
  userId: string | null;
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
    private readonly links: GoalLinksService,
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
    const membershipId = actingMembershipId(u.principal);
    const scope = await resolveGoalsScope(this.access, u);

    const conditions: ReturnType<typeof and>[] = [eq(okrGoals.orgId, orgId), isNull(okrGoals.deletedAt)];

    if (scope !== "all") {
      const ownershipFilter = membershipId !== null
        ? or(
            eq(okrGoals.ownerMembershipId, membershipId),
            eq(okrGoals.createdByMembershipId, membershipId),
          )
        : eq(okrGoals.ownerMembershipId, -1);
      if (ownershipFilter) conditions.push(ownershipFilter);
    }

    if (filters.status) conditions.push(eq(okrGoals.status, filters.status));
    if (filters.level) conditions.push(eq(okrGoals.level, filters.level));
    if (filters.ownerId) conditions.push(sql`EXISTS (SELECT 1 FROM organization_members om WHERE om.org_id = ${orgId} AND om.user_id = ${filters.ownerId} AND om.id = ${okrGoals.ownerMembershipId})`);
    if (filters.projectId !== undefined)
      conditions.push(eq(okrGoals.projectId, filters.projectId));
    if (filters.search)
      conditions.push(ilike(okrGoals.title, `%${filters.search}%`));

    const limit = Math.min(filters.limit, 100);
    const offset = (filters.page - 1) * limit;

    const goals = await this.db.query.okrGoals.findMany({
      where: and(...conditions),
      orderBy: [desc(okrGoals.createdAt)],
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
      owner: null,
      keyResultCount: countMap.get(goal.id) ?? 0,
    }));
  }

  create(orgId: string, userId: string, input: CreateInput, membershipId?: number | null): Promise<typeof okrGoals.$inferSelect> {
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(okrGoals)
        .values({
          orgId,
          title: input.title,
          description: input.description ?? null,
          ownerMembershipId: membershipId ?? null,
          level: input.level,
          status: input.status,
          startDate: input.startDate ?? null,
          dueDate: input.dueDate ?? null,
          parentGoalId: input.parentGoalId ?? null,
          projectId: input.projectId ?? null,
          createdByMembershipId: membershipId ?? null,
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

      return created!;
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
      .where(and(eq(okrGoals.orgId, orgId), isNull(okrGoals.deletedAt)))
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
      where: and(eq(okrGoals.id, goalId), eq(okrGoals.orgId, orgId), isNull(okrGoals.deletedAt)),
      with: {
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

    const links = await this.links.getLinks(orgId, goalId);

    return { ...goal, owner: null, keyResults, updates, links };
  }

  async update(orgId: string, goalId: number, input: UpdateInput): Promise<typeof okrGoals.$inferSelect | null> {
    const [updated] = await this.db
      .update(okrGoals)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(okrGoals.id, goalId), eq(okrGoals.orgId, orgId), isNull(okrGoals.deletedAt)))
      .returning();

    if (!updated) return null;
    return updated;
  }

  async remove(orgId: string, goalId: number): Promise<{ success: true } | null> {
    const [deleted] = await this.db
      .update(okrGoals)
      .set({ deletedAt: new Date() })
      .where(and(eq(okrGoals.id, goalId), eq(okrGoals.orgId, orgId), isNull(okrGoals.deletedAt)))
      .returning({ id: okrGoals.id });

    if (!deleted) return null;
    return { success: true };
  }

  async checkIn(
    orgId: string,
    userId: string,
    goalId: number,
    input: CheckInInput,
  ): Promise<typeof okrGoals.$inferSelect | null> {
    const goalExists = await this.db.query.okrGoals.findFirst({
      where: and(eq(okrGoals.id, goalId), eq(okrGoals.orgId, orgId), isNull(okrGoals.deletedAt)),
      columns: { id: true },
    });
    if (!goalExists) return null;

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
      where: and(eq(okrGoals.id, goalId), eq(okrGoals.orgId, orgId), isNull(okrGoals.deletedAt)),
    });

    return goal ?? null;
  }
}
