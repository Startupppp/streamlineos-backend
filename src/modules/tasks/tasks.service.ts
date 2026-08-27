import { Inject, Injectable } from "@nestjs/common";
import {
  eq,
  and,
  asc,
  desc,
  count,
  lt,
  gte,
  isNotNull,
  sql,
} from "drizzle-orm";
import { tasks, taskSequences, taskSequenceSteps, crmActivities, users } from "../../db/schema";
import { crmActivityTypeEnum } from "../../db/schema/common/enums";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { TaskNotificationsService } from "./task-notifications.service";
import { AccessService } from "../access/access.service";
import { logSideEffectFailure } from "../../common/logger/side-effect";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type {
  ListInput,
  CreateInput,
  UpdateInput,
  CompleteInput,
  AnalyticsInput,
  SequenceListInput,
  SequenceCreateInput,
  SequenceApplyInput,
} from "./dto/task.schemas";

/**
 * Derived from the pgEnum, not hand-listed (§7: never maintain a parallel
 * union). The hand-written copy had already drifted — it omitted the value this
 * file needs, and a stale literal union fails silently at the call site rather
 * than at the schema.
 */
type CrmActivityType = (typeof crmActivityTypeEnum.enumValues)[number];

type TaskBucket = "OVERDUE" | "TODAY" | "THIS_WEEK" | "UPCOMING" | "NO_DATE";

function addDays(date: Date, amount: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function addWeeks(date: Date, amount: number): Date {
  return addDays(date, amount * 7);
}

function addMonths(date: Date, amount: number): Date {
  const result = new Date(date);
  const targetDay = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + amount);
  const daysInMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(targetDay, daysInMonth));
  return result;
}

@Injectable()
export class TasksService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: TaskNotificationsService,
    private readonly access: AccessService,
  ) {}

  /**
   * `tasks:read` is a universal employee grant, so it only ever exposes the
   * caller's own tasks. Seeing the whole org queue requires `crm:tasks:view`.
   */
  private async canViewAllTasks(actor: CurrentUserContext): Promise<boolean> {
    if (actor.isOrgOwner) return true;
    const resolved = await this.access.resolveUserPermissions(
      actor.orgId,
      actor.userId,
    );
    return (resolved.get("crm:tasks:view") ?? "none") !== "none";
  }

  async list(actor: CurrentUserContext, filters: ListInput) {
    const { orgId, userId } = actor;
    const offset = (filters.page - 1) * filters.limit;
    const canViewAll = await this.canViewAllTasks(actor);
    const resolvedAssigneeId = filters.assigneeId === "me" ? userId : filters.assigneeId;

    const conditions = [eq(tasks.orgId, orgId)];
    if (!canViewAll) conditions.push(eq(tasks.assigneeId, userId));
    else if (resolvedAssigneeId)
      conditions.push(eq(tasks.assigneeId, resolvedAssigneeId));
    if (filters.status) conditions.push(eq(tasks.status, filters.status));
    if (filters.type) conditions.push(eq(tasks.type, filters.type));
    if (filters.entityType) conditions.push(eq(tasks.entityType, filters.entityType));
    if (filters.entityId) conditions.push(eq(tasks.entityId, Number(filters.entityId)));

    const whereClause = and(...conditions);

    const [rows, totalResult] = await Promise.all([
      this.db
        .select()
        .from(tasks)
        .where(whereClause)
        .orderBy(asc(tasks.dueDate), desc(tasks.createdAt))
        .limit(filters.limit)
        .offset(offset),
      this.db.select({ count: count() }).from(tasks).where(whereClause),
    ]);

    return { tasks: rows, total: totalResult[0]?.count ?? 0, page: filters.page, limit: filters.limit };
  }

  async create(orgId: string, userId: string, input: CreateInput) {
    const [created] = await this.db
      .insert(tasks)
      .values({
        orgId,
        title: input.title,
        notes: input.notes,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        type: input.type,
        assigneeId: input.assigneeId ?? userId,
        createdBy: userId,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        remindAt: input.remindAt ? new Date(input.remindAt) : null,
        timezone: input.timezone ?? null,
      })
      .returning();

    if (created && created.assigneeId && created.assigneeId !== userId) {
      const entityLabel = input.entityType
        ? `${input.entityType} #${input.entityId ?? ""}`
        : undefined;
      void this.notifications
        .notifyAssignee({
          orgId,
          assigneeId: created.assigneeId,
          actorId: userId,
          title: created.title,
          type: created.type,
          dueDate: created.dueDate,
          entityLabel,
        })
        .catch(logSideEffectFailure("task assignee notification", { orgId }));
    }

    return created ?? null;
  }

  async getTask(orgId: string, id: number) {
    const [existing] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.orgId, orgId)))
      .limit(1);
    return existing ?? null;
  }

  async update(orgId: string, id: number, userId: string, input: UpdateInput) {
    const existing = await this.getTask(orgId, id);
    if (!existing) return null;

    const [updated] = await this.db
      .update(tasks)
      .set({
        ...(input.title !== undefined && { title: input.title }),
        ...(input.notes !== undefined && { notes: input.notes }),
        ...(input.type !== undefined && { type: input.type }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.assigneeId !== undefined && { assigneeId: input.assigneeId }),
        ...(input.dueDate !== undefined && {
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
        }),
        ...(input.remindAt !== undefined && {
          remindAt: input.remindAt ? new Date(input.remindAt) : null,
        }),
        ...(input.timezone !== undefined && { timezone: input.timezone }),
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, id), eq(tasks.orgId, orgId)))
      .returning();

    if (
      updated &&
      input.assigneeId &&
      input.assigneeId !== existing.assigneeId &&
      input.assigneeId !== userId
    ) {
      void this.notifications
        .notifyAssignee({
          orgId,
          assigneeId: input.assigneeId,
          actorId: userId,
          title: updated.title,
          type: updated.type,
          dueDate: updated.dueDate,
        })
        .catch(logSideEffectFailure("task assignee notification", { orgId }));
    }

    return updated ?? null;
  }

  async remove(orgId: string, id: number) {
    const [deleted] = await this.db
      .delete(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.orgId, orgId)))
      .returning({ id: tasks.id });

    if (!deleted) return null;
    return { success: true };
  }

  async complete(orgId: string, id: number, input: CompleteInput) {
    const existing = await this.getTask(orgId, id);
    if (!existing) return null;
    if (existing.status === "completed") return existing;

    const completedAt = input.completedAt ? new Date(input.completedAt) : new Date();

    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(tasks)
        .set({ status: "completed", completedAt, updatedAt: new Date() })
        .where(and(eq(tasks.id, id), eq(tasks.orgId, orgId)))
        .returning();

      if (!updated) return null;

      const typeToActivity: Partial<Record<string, CrmActivityType>> = {
        CALL: "call",
        EMAIL: "email",
        MEETING: "meeting",
      };
      // Anything that is not a call/email/meeting is a plain task completion.
      // The old fallback was "deal_won", which fabricated a won-deal activity in
      // the sales feed (`crm-sales-dashboard.service.ts` filters category
      // "sales") every time someone ticked off an ordinary TODO.
      const activityType: CrmActivityType = typeToActivity[existing.type] ?? "task_completed";

      await tx.insert(crmActivities).values({
        orgId,
        type: activityType,
        message: `Task completed: ${existing.title}`,
        time: completedAt.toISOString(),
        category: "sales",
      });

      const recurrence = existing.recurrence;
      if (recurrence && existing.dueDate) {
        const prevDue = new Date(existing.dueDate);
        const interval = recurrence.interval ?? 1;
        let nextDue: Date;

        if (recurrence.frequency === "DAILY") {
          nextDue = addDays(prevDue, interval);
        } else if (recurrence.frequency === "WEEKLY") {
          nextDue = addWeeks(prevDue, interval);
        } else {
          nextDue = addMonths(prevDue, interval);
        }

        const endDate = recurrence.endDate ? new Date(recurrence.endDate) : null;
        const withinRange = !endDate || nextDue <= endDate;

        if (withinRange) {
          await tx.insert(tasks).values({
            orgId,
            title: existing.title,
            notes: existing.notes,
            entityType: existing.entityType,
            entityId: existing.entityId,
            type: existing.type,
            status: "pending",
            assigneeId: existing.assigneeId,
            createdBy: existing.createdBy,
            dueDate: nextDue,
            remindAt: existing.remindAt,
            timezone: existing.timezone,
            recurrence: existing.recurrence,
            parentTaskId: existing.id,
          });
        }
      }

      return updated;
    });
  }

  async myQueue(orgId: string, userId: string) {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    const rows = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.orgId, orgId),
          eq(tasks.assigneeId, userId),
          eq(tasks.status, "pending"),
        ),
      )
      .orderBy(asc(tasks.dueDate), asc(tasks.createdAt))
      .limit(50);

    const categorised = rows.map((task) => {
      let bucket: TaskBucket = "NO_DATE";

      if (task.dueDate) {
        const due = new Date(task.dueDate);
        if (due < todayStart) {
          bucket = "OVERDUE";
        } else if (due <= todayEnd) {
          bucket = "TODAY";
        } else {
          const weekEnd = new Date(todayEnd);
          weekEnd.setDate(weekEnd.getDate() + 6);
          bucket = due <= weekEnd ? "THIS_WEEK" : "UPCOMING";
        }
      }

      return { ...task, bucket };
    });

    const bucketOrder: Record<string, number> = {
      OVERDUE: 0,
      TODAY: 1,
      THIS_WEEK: 2,
      UPCOMING: 3,
      NO_DATE: 4,
    };
    categorised.sort(
      (a, b) =>
        bucketOrder[a.bucket] - bucketOrder[b.bucket] ||
        (a.dueDate && b.dueDate
          ? new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
          : 0),
    );

    return categorised;
  }

  async overdue(orgId: string, countOnly: boolean) {
    const now = new Date();
    const conditions = [
      eq(tasks.orgId, orgId),
      eq(tasks.status, "pending"),
      isNotNull(tasks.dueDate),
      lt(tasks.dueDate, now),
    ];

    if (countOnly) {
      const rows = await this.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(...conditions));
      return { count: rows.length };
    }

    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(tasks.dueDate)
      .limit(100);

    return { tasks: rows, count: rows.length };
  }

  async analytics(orgId: string, input: AnalyticsInput) {
    const days = input.days;
    const now = new Date();
    const periodStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const [totalRow] = await this.db
      .select({ total: count() })
      .from(tasks)
      .where(and(eq(tasks.orgId, orgId), gte(tasks.createdAt, periodStart)));

    const [completedRow] = await this.db
      .select({ completed: count() })
      .from(tasks)
      .where(
        and(eq(tasks.orgId, orgId), eq(tasks.status, "completed"), gte(tasks.createdAt, periodStart)),
      );

    const [overdueRow] = await this.db
      .select({ overdue: count() })
      .from(tasks)
      .where(
        and(
          eq(tasks.orgId, orgId),
          eq(tasks.status, "pending"),
          lt(tasks.dueDate, now),
          isNotNull(tasks.dueDate),
        ),
      );

    const perRep = await this.db
      .select({
        assigneeId: tasks.assigneeId,
        firstName: users.firstName,
        lastName: users.lastName,
        name: users.name,
        total: count(),
        completed: sql<number>`SUM(CASE WHEN ${tasks.status} = 'completed' THEN 1 ELSE 0 END)`,
        overdue: sql<number>`SUM(CASE WHEN ${tasks.status} = 'pending' AND ${tasks.dueDate} < NOW() THEN 1 ELSE 0 END)`,
      })
      .from(tasks)
      .leftJoin(users, eq(tasks.assigneeId, users.id))
      .where(
        and(eq(tasks.orgId, orgId), isNotNull(tasks.assigneeId), gte(tasks.createdAt, periodStart)),
      )
      .groupBy(tasks.assigneeId, users.firstName, users.lastName, users.name)
      .orderBy(sql`SUM(CASE WHEN ${tasks.status} = 'completed' THEN 1 ELSE 0 END) DESC`)
      .limit(20);

    const totalNum = Number(totalRow?.total ?? 0);
    const completedNum = Number(completedRow?.completed ?? 0);
    const overdueNum = Number(overdueRow?.overdue ?? 0);

    return {
      period: days,
      total: totalNum,
      completed: completedNum,
      overdue: overdueNum,
      completionRate: totalNum > 0 ? Math.round((completedNum / totalNum) * 100) : 0,
      perRep: perRep.map((r) => ({
        assigneeId: r.assigneeId,
        name:
          r.firstName && r.lastName
            ? `${r.firstName} ${r.lastName}`
            : (r.name ?? "Unknown"),
        total: Number(r.total),
        completed: Number(r.completed),
        overdue: Number(r.overdue),
        completionRate:
          Number(r.total) > 0
            ? Math.round((Number(r.completed) / Number(r.total)) * 100)
            : 0,
      })),
    };
  }

  listSequences(orgId: string, input: SequenceListInput) {
    return this.db.query.taskSequences.findMany({
      where: eq(taskSequences.orgId, orgId),
      with: { steps: { orderBy: (s, { asc: ascOp }) => [ascOp(s.order)] } },
      orderBy: (t, { desc: descOp }) => [descOp(t.createdAt)],
      limit: input.limit,
    });
  }

  async createSequence(orgId: string, userId: string, input: SequenceCreateInput) {
    return this.db.transaction(async (tx) => {
      const [seq] = await tx
        .insert(taskSequences)
        .values({
          orgId,
          name: input.name,
          description: input.description,
          createdBy: userId,
        })
        .returning();

      if (input.steps.length > 0) {
        await tx.insert(taskSequenceSteps).values(
          input.steps.map((step, i) => ({
            sequenceId: seq.id,
            title: step.title,
            type: step.type,
            notes: step.notes,
            offsetDays: step.offsetDays,
            order: step.order ?? i,
          })),
        );
      }

      return tx.query.taskSequences.findFirst({
        where: eq(taskSequences.id, seq.id),
        with: { steps: { orderBy: (s, { asc: ascOp }) => [ascOp(s.order)] } },
      });
    });
  }

  async removeSequence(orgId: string, sequenceId: number) {
    const [deleted] = await this.db
      .delete(taskSequences)
      .where(and(eq(taskSequences.id, sequenceId), eq(taskSequences.orgId, orgId)))
      .returning();

    if (!deleted) return null;
    return { success: true };
  }

  async applySequence(orgId: string, userId: string, sequenceId: number, input: SequenceApplyInput) {
    const seq = await this.db.query.taskSequences.findFirst({
      where: and(eq(taskSequences.id, sequenceId), eq(taskSequences.orgId, orgId)),
      with: { steps: { orderBy: (s, { asc: ascOp }) => [ascOp(s.order)] } },
    });

    if (!seq) return { error: "not_found" as const };
    if (seq.steps.length === 0) return { error: "no_steps" as const };

    const base = new Date(input.baseDate);

    const created = await this.db
      .insert(tasks)
      .values(
        seq.steps.map((step) => ({
          orgId,
          title: step.title,
          notes: step.notes ?? null,
          type: (step.type as "CALL" | "EMAIL" | "MEETING" | "CUSTOM") ?? "CUSTOM",
          status: "pending" as const,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          assigneeId: input.assigneeId ?? null,
          createdBy: userId,
          dueDate: addDays(base, step.offsetDays),
        })),
      )
      .returning();

    return { created, count: created.length };
  }
}

export type ApplySequenceResult = Awaited<ReturnType<TasksService["applySequence"]>>;

export function isSequenceNotFound(
  result: ApplySequenceResult,
): result is { error: "not_found" } {
  return "error" in result && result.error === "not_found";
}

export function isSequenceNoSteps(
  result: ApplySequenceResult,
): result is { error: "no_steps" } {
  return "error" in result && result.error === "no_steps";
}
