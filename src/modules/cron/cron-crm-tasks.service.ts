import { Inject, Injectable } from "@nestjs/common";
import { and, eq, lt, gte, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { tasks } from "../../db/schema";
import { CrmAutomationBusService } from "../crm-automation-studio/crm-automation-bus.service";

@Injectable()
export class CronCrmTasksService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly bus: CrmAutomationBusService,
  ) {}

  async flushOverdueTasks(): Promise<{ emitted: number }> {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const newlyOverdue = await this.db
      .select({
        id: tasks.id,
        orgId: tasks.orgId,
        entityType: tasks.entityType,
        entityId: tasks.entityId,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, "pending"),
          gte(tasks.dueDate, oneHourAgo),
          lt(tasks.dueDate, now),
          isNull(tasks.snoozedUntil),
        ),
      )
      .limit(200);

    for (const task of newlyOverdue) {
      void this.bus.emit(task.orgId, "task.overdue", {
        entityType: "task",
        entityId: String(task.id),
        data: {
          taskId: task.id,
          relatedEntityType: task.entityType ?? null,
          relatedEntityId: task.entityId ?? null,
        },
      }).catch(() => undefined);
    }

    return { emitted: newlyOverdue.length };
  }
}
