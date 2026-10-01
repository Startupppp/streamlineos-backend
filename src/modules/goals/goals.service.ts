import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  avg,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
  sum,
} from "drizzle-orm";
import {
  okrGoals,
  okrKeyResults,
  okrLinks,
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
import { goalsInManagedProductCondition } from "./goals-project-scope";
import type {
  CheckInInput,
  CreateInput,
  ListInput,
  UpdateInput,
} from "./dto/goal.schemas";
import { GoalLinksService, type GoalLinkRow } from "./goal-links.service";
import {
  buildListResponse,
  type ListResponse,
} from "../../common/pagination/pagination";
import { TicketVersionConflictException } from "../build/core";
import {
  normalizeRolledUpValue,
  rollUpKeyResultValues,
  type KeyResultRollup,
} from "./goals-key-result-rollup";

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

type GoalListItem = typeof okrGoals.$inferSelect &
  KeyResultRollup & { owner: GoalOwner | null; keyResultCount: number };

type GoalDetail = typeof okrGoals.$inferSelect &
  KeyResultRollup & {
    owner: GoalOwner | null;
    project: GoalProject | null;
    keyResults: Array<typeof okrKeyResults.$inferSelect>;
    updates: GoalUpdateRow[];
    links: GoalLinkRow[];
  };

function goalHealthWhere(health: "on_track" | "at_risk" | "off_track") {
  const notOverdue = or(
    isNull(okrGoals.dueDate),
    gte(okrGoals.dueDate, sql`CURRENT_DATE`),
  );
  const isOverdue = and(
    isNotNull(okrGoals.dueDate),
    lt(okrGoals.dueDate, sql`CURRENT_DATE`),
  );
  if (health === "on_track") {
    return or(
      eq(okrGoals.status, "completed"),
      and(
        notOverdue,
        ne(okrGoals.status, "off_track"),
        ne(okrGoals.status, "at_risk"),
        or(eq(okrGoals.status, "on_track"), gte(okrGoals.progress, 70)),
      ),
    );
  }
  if (health === "at_risk") {
    return and(
      notOverdue,
      ne(okrGoals.status, "completed"),
      ne(okrGoals.status, "off_track"),
      or(
        eq(okrGoals.status, "at_risk"),
        and(
          ne(okrGoals.status, "on_track"),
          gte(okrGoals.progress, 30),
          lt(okrGoals.progress, 70),
        ),
      ),
    );
  }
  return and(
    ne(okrGoals.status, "completed"),
    or(
      isOverdue,
      eq(okrGoals.status, "off_track"),
      and(
        notOverdue,
        notInArray(okrGoals.status, [
          "off_track",
          "at_risk",
          "on_track",
        ] as const),
        lt(okrGoals.progress, 30),
      ),
    ),
  );
}

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

  private async loadOwners(
    orgId: string,
    membershipIds: number[],
  ): Promise<Map<number, GoalOwner>> {
    const ids = [
      ...new Set(membershipIds.filter((id) => Number.isInteger(id))),
    ];
    if (ids.length === 0) return new Map();

    const rows = await this.db
      .select({
        membershipId: organizationMembers.id,
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          inArray(organizationMembers.id, ids),
        ),
      );

    return new Map(
      rows.map(({ membershipId, id, name, email, image }) => [
        membershipId,
        { id, name, email, image },
      ]),
    );
  }

  async list(
    u: CurrentUserContext,
    filters: ListInput,
  ): Promise<ListResponse<GoalListItem>> {
    const { orgId, userId } = u;
    const membershipId = actingMembershipId(u.principal);
    const read = await resolveGoalsScope(this.access, u);

    // Ownership on a goal is a membership id on either the owner or the creator, so it is a domain predicate rather than a user column.
    const ownGoal =
      membershipId !== null
        ? or(
            eq(okrGoals.ownerMembershipId, membershipId),
            eq(okrGoals.createdByMembershipId, membershipId),
          )
        : eq(okrGoals.ownerMembershipId, -1);

    const limit = Math.min(filters.limit, 100);
    const offset = (filters.page - 1) * limit;
    const page = { page: filters.page, pageSize: limit };
    const where = read.compose(
      {
        tenant: okrGoals.orgId,
        scope: { own: ownGoal ?? eq(okrGoals.ownerMembershipId, -1) },
        and: [
          isNull(okrGoals.deletedAt),
          filters.status ? eq(okrGoals.status, filters.status) : undefined,
          filters.level ? eq(okrGoals.level, filters.level) : undefined,
          filters.ownerId
            ? sql`EXISTS (SELECT 1 FROM organization_members om WHERE om.org_id = ${orgId} AND om.user_id = ${filters.ownerId} AND om.id = ${okrGoals.ownerMembershipId})`
            : undefined,
          filters.projectId !== undefined
            ? eq(okrGoals.projectId, filters.projectId)
            : undefined,
          filters.managedProductId !== undefined
            ? goalsInManagedProductCondition(orgId, filters.managedProductId)
            : undefined,
          filters.search
            ? sql`to_tsvector('english', coalesce(${okrGoals.title}, '')) @@ plainto_tsquery('english', ${filters.search})`
            : undefined,
          filters.due ? lte(okrGoals.dueDate, filters.due) : undefined,
          filters.scope === "own" && membershipId !== null
            ? eq(okrGoals.ownerMembershipId, membershipId)
            : undefined,
          filters.health ? goalHealthWhere(filters.health) : undefined,
        ],
      },
      (clause) => clause.sql,
      () => null,
    );
    if (where === null) return buildListResponse([], 0, page);

    const [goals, [totalRow]] = await Promise.all([
      this.db.query.okrGoals.findMany({
        where,
        orderBy: [desc(okrGoals.createdAt)],
        limit,
        offset,
      }),
      this.db.select({ total: count() }).from(okrGoals).where(where),
    ]);
    const total = Number(totalRow?.total ?? 0);

    if (goals.length === 0) return buildListResponse([], total, page);

    const goalIds = goals.map((g) => g.id);
    const [counts, linkCounts, owners] = await Promise.all([
      this.db
        .select({
          goalId: okrKeyResults.goalId,
          total: count(),
          target: sum(okrKeyResults.targetValue),
          current: sum(okrKeyResults.currentValue),
        })
        .from(okrKeyResults)
        .where(
          and(
            eq(okrKeyResults.orgId, orgId),
            inArray(okrKeyResults.goalId, goalIds),
          ),
        )
        .groupBy(okrKeyResults.goalId),
      this.db
        .select({
          goalId: okrLinks.goalId,
          total: count(),
          ticketLinks: count(okrLinks.ticketId),
          projectLinks: count(okrLinks.projectId),
        })
        .from(okrLinks)
        .where(
          and(eq(okrLinks.orgId, orgId), inArray(okrLinks.goalId, goalIds)),
        )
        .groupBy(okrLinks.goalId),
      this.loadOwners(
        orgId,
        goals.map((goal) => goal.ownerMembershipId ?? -1),
      ),
    ]);

    const countMap = new Map(counts.map((c) => [c.goalId, c]));
    const linkMap = new Map(linkCounts.map((c) => [c.goalId, c]));

    return buildListResponse(
      goals.map((goal) => {
        const rollup = countMap.get(goal.id);
        const links = linkMap.get(goal.id);
        return {
          ...goal,
          owner:
            goal.ownerMembershipId === null
              ? null
              : (owners.get(goal.ownerMembershipId) ?? null),
          linkCount: links?.total ?? 0,
          linkedTicketCount: links?.ticketLinks ?? 0,
          linkedProjectCount: links?.projectLinks ?? 0,
          keyResultCount: rollup?.total ?? 0,
          target: normalizeRolledUpValue(rollup?.target ?? null),
          current: normalizeRolledUpValue(rollup?.current ?? null),
        };
      }),
      total,
      page,
    );
  }

  create(
    orgId: string,
    userId: string,
    input: CreateInput,
    membershipId?: number | null,
  ): Promise<typeof okrGoals.$inferSelect> {
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
          confidence: input.confidence ?? null,
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
      where: and(
        eq(okrGoals.id, goalId),
        eq(okrGoals.orgId, orgId),
        isNull(okrGoals.deletedAt),
      ),
      with: {
        project: { columns: { id: true, name: true, key: true } },
      },
    });
    if (!goal) return null;

    const owners = await this.loadOwners(
      orgId,
      goal.ownerMembershipId === null ? [] : [goal.ownerMembershipId],
    );

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

    return {
      ...goal,
      ...rollUpKeyResultValues(keyResults),
      owner:
        goal.ownerMembershipId === null
          ? null
          : (owners.get(goal.ownerMembershipId) ?? null),
      keyResults,
      updates,
      links,
    };
  }

  async update(
    orgId: string,
    goalId: number,
    input: UpdateInput,
  ): Promise<GoalDetail | null> {
    const { version, ...changes } = input;
    const tenantMatch = and(
      eq(okrGoals.id, goalId),
      eq(okrGoals.orgId, orgId),
      isNull(okrGoals.deletedAt),
    );

    const before = await this.db.query.okrGoals.findFirst({
      where: tenantMatch,
      columns: { version: true },
    });
    if (!before) return null;
    if (version !== before.version)
      throw new TicketVersionConflictException(before.version);

    const [updated] = await this.db
      .update(okrGoals)
      .set({ ...changes, updatedAt: new Date() })
      .where(and(tenantMatch, eq(okrGoals.version, before.version)))
      .returning({ id: okrGoals.id });

    if (!updated) {
      const current = await this.db.query.okrGoals.findFirst({
        where: and(eq(okrGoals.id, goalId), eq(okrGoals.orgId, orgId)),
        columns: { version: true },
      });
      throw new TicketVersionConflictException(
        current?.version ?? before.version,
      );
    }
    return this.getGoal(orgId, goalId);
  }

  async remove(
    orgId: string,
    goalId: number,
  ): Promise<{ success: true } | null> {
    const [deleted] = await this.db
      .update(okrGoals)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(okrGoals.id, goalId),
          eq(okrGoals.orgId, orgId),
          isNull(okrGoals.deletedAt),
        ),
      )
      .returning({ id: okrGoals.id });

    if (!deleted) return null;
    return { success: true };
  }

  async checkIn(
    orgId: string,
    userId: string,
    goalId: number,
    input: CheckInInput,
  ): Promise<GoalDetail | null> {
    const goalExists = await this.db.query.okrGoals.findFirst({
      where: and(
        eq(okrGoals.id, goalId),
        eq(okrGoals.orgId, orgId),
        isNull(okrGoals.deletedAt),
      ),
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

    return this.getGoal(orgId, goalId);
  }
}
