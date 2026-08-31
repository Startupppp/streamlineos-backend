import { Inject, Injectable } from "@nestjs/common";
import { eq, and, desc, count } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetBefore } from "../../common/pagination/keyset";
import { tasks, crmActivities } from "../../db/schema";
import { crmActivityTypeEnum } from "../../db/schema/common/enums";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { TaskNotificationsService } from "./task-notifications.service";
import { AccessService } from "../access/access.service";
import { logSideEffectFailure } from "../../common/logger/side-effect";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { ListInput, CreateInput, UpdateInput, CompleteInput } from "./dto/task.schemas";
import { addDays, addWeeks, addMonths } from "./task-date-utils";

type CrmActivityType = (typeof crmActivityTypeEnum.enumValues)[number];

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
    const canViewAll = await this.canViewAllTasks(actor);
    const resolvedAssigneeId = filters.assigneeId === "me" ? userId : filters.assigneeId;
    const limit = filters.limit;

    const conditions = [eq(tasks.orgId, orgId)];
    if (!canViewAll) conditions.push(eq(tasks.assigneeId, userId));
    else if (resolvedAssigneeId)
      conditions.push(eq(tasks.assigneeId, resolvedAssigneeId));
    if (filters.status) conditions.push(eq(tasks.status, filters.status));
    if (filters.type) conditions.push(eq(tasks.type, filters.type));
    if (filters.entityType) conditions.push(eq(tasks.entityType, filters.entityType));
    if (filters.entityId) conditions.push(eq(tasks.entityId, Number(filters.entityId)));

    const position = decodeCursor(filters.cursor);
    const where = position
      ? and(...conditions, keysetBefore(tasks.createdAt, tasks.id, position))
      : and(...conditions);

    const [rows, totalResult] = await Promise.all([
      this.db
        .select()
        .from(tasks)
        .where(where)
        .orderBy(desc(tasks.createdAt), desc(tasks.id))
        .limit(limit + 1),
      filters.cursor === undefined
        ? this.db.select({ count: count() }).from(tasks).where(and(...conditions))
        : Promise.resolve(null),
    ]);

    const page = buildCursorPage(rows, limit, (t) => ({ sortValue: t.createdAt.toISOString(), id: String(t.id) }));
    return {
      tasks: page.data,
      hasMore: page.pagination.hasMore,
      nextCursor: page.pagination.nextCursor,
      total: totalResult ? (totalResult[0]?.count ?? 0) : undefined,
    };
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
}
