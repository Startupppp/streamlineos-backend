import { Inject, Injectable } from "@nestjs/common";
import { and, avg, count, desc, eq, gt, ilike, inArray, isNull, or } from "drizzle-orm";
import {
  okrGoals,
  okrKeyResults,
  okrUpdates,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import { resolveGoalsScope } from "./goals-scope";
import { recomputeGoalProgress } from "./goals-progress";
import type {
  CheckInInput,
  CreateInput,
  ListInput,
  UpdateInput,
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
};

@Injectable()
export class GoalsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async list(u: CurrentUserContext, filters: ListInput) {
    const { orgId, userId } = u;
    const scope = await resolveGoalsScope(this.access, u);

    const conditions: ReturnType<typeof and>[] = [eq(okrGoals.orgId, orgId), isNull(okrGoals.deletedAt)];

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
    if (filters.cursor) conditions.push(gt(okrGoals.id, filters.cursor));

    const rows = await this.db
      .select({
        id: okrGoals.id,
        orgId: okrGoals.orgId,
        title: okrGoals.title,
        description: okrGoals.description,
        ownerId: okrGoals.ownerId,
        level: okrGoals.level,
        status: okrGoals.status,
        progress: okrGoals.progress,
        startDate: okrGoals.startDate,
        dueDate: okrGoals.dueDate,
        parentGoalId: okrGoals.parentGoalId,
        projectId: okrGoals.projectId,
        createdBy: okrGoals.createdBy,
        createdAt: okrGoals.createdAt,
        updatedAt: okrGoals.updatedAt,
        deletedAt: okrGoals.deletedAt,
        ownerUserId: users.id,
        ownerName: users.name,
        ownerEmail: users.email,
        ownerImage: users.image,
      })
      .from(okrGoals)
      .leftJoin(users, eq(users.id, okrGoals.ownerId))
      .where(and(...conditions))
      .orderBy(desc(okrGoals.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    if (page.length === 0) return { data: [], hasMore: false, nextCursor: null };

    const goalIds = page.map((g) => g.id);
    const counts = await this.db
      .select({ goalId: okrKeyResults.goalId, total: count() })
      .from(okrKeyResults)
      .where(and(eq(okrKeyResults.orgId, orgId), inArray(okrKeyResults.goalId, goalIds)))
      .groupBy(okrKeyResults.goalId);

    const countMap = new Map(counts.map((c) => [c.goalId, c.total]));

    const data = page.map((row) => ({
      id: row.id,
      orgId: row.orgId,
      title: row.title,
      description: row.description,
      ownerId: row.ownerId,
      level: row.level,
      status: row.status,
      progress: row.progress,
      startDate: row.startDate,
      dueDate: row.dueDate,
      parentGoalId: row.parentGoalId,
      projectId: row.projectId,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      owner: row.ownerUserId
        ? { id: row.ownerUserId, name: row.ownerName, email: row.ownerEmail, image: row.ownerImage }
        : null,
      keyResultCount: countMap.get(row.id) ?? 0,
    }));

    return { data, hasMore, nextCursor };
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

    return { ...goal, keyResults, updates };
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

    await recomputeGoalProgress(this.db, goalId, orgId);

    const goal = await this.db.query.okrGoals.findFirst({
      where: and(eq(okrGoals.id, goalId), eq(okrGoals.orgId, orgId), isNull(okrGoals.deletedAt)),
    });

    return goal ?? null;
  }
}
