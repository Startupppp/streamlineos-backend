import { Inject, Injectable } from "@nestjs/common";
import {
  eq,
  and,
  asc,
  desc,
  count,
  lt,
  isNotNull,
} from "drizzle-orm";
import { tasks, taskSequences, crmActivities } from "../../db/schema";
import { crmActivityTypeEnum } from "../../db/schema/common/enums";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { TaskNotificationsService } from "./task-notifications.service";
import { AccessService } from "../access/access.service";
import { logSideEffectFailure } from "../../common/logger/side-effect";
import { addDays, addWeeks, addMonths } from "./task-date-utils";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type {
  ListInput,
  CreateInput,
  UpdateInput,
  CompleteInput,
} from "./dto/task.schemas";

type CrmActivityType = (typeof crmActivityTypeEnum.enumValues)[number];

type TaskBucket = "OVERDUE" | "TODAY" | "THIS_WEEK" | "UPCOMING" | "NO_DATE";

@Injectable()
export class TasksService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: TaskNotificationsService,
    private readonly access: AccessService,
  ) {}

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
}
