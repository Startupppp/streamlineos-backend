import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, gt, lt, gte, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { tasks } from "../../db/schema";
import { CrmAutomationBusService } from "../crm/automation-studio/crm-automation-bus.service";
import { forEachOrg } from "../../common/tenant";
import { drainPages } from "./drain";

const PAGE_SIZE = 200;
/**
 * The window is one hour wide and moves with the tick, so anything not emitted in
 * this run is lost rather than deferred: a bare `.limit(200)` permanently dropped
 * every task past the two-hundredth that fell due in the same hour.
 */
const MAX_PAGES = 50;

export interface CrmOverdueTaskResult {
  emitted: number;
  organizationsFailed: number;
  /** The cap was hit with tasks still in the window — those emissions are lost, not deferred. */
  truncated: boolean;
}

@Injectable()
export class CronCrmTasksService {
  private readonly logger = new Logger(CronCrmTasksService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly bus: CrmAutomationBusService,
  ) {}

  async flushOverdueTasks(): Promise<CrmOverdueTaskResult> {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const result: CrmOverdueTaskResult = {
      emitted: 0,
      organizationsFailed: 0,
      truncated: false,
    };

    const sweepResult = await forEachOrg(this.db, "flush-overdue-tasks", async (tx, orgId) => {
      let after = 0;
      const outcome = await drainPages(PAGE_SIZE, MAX_PAGES, async () => {
        const newlyOverdue = await tx
          .select({
            id: tasks.id,
            entityType: tasks.entityType,
            entityId: tasks.entityId,
          })
          .from(tasks)
          .where(
            and(
              eq(tasks.orgId, orgId),
              eq(tasks.status, "pending"),
              gte(tasks.dueDate, oneHourAgo),
              lt(tasks.dueDate, now),
              isNull(tasks.snoozedUntil),
              gt(tasks.id, after),
            ),
          )
          .orderBy(asc(tasks.id))
          .limit(PAGE_SIZE);

        if (newlyOverdue.length === 0) return { selected: 0, processed: 0 };

        for (const task of newlyOverdue) {
          await this.bus
            .emit(orgId, "task.overdue", {
              entityType: "task",
              entityId: String(task.id),
              data: {
                taskId: task.id,
                relatedEntityType: task.entityType ?? null,
                relatedEntityId: task.entityId ?? null,
              },
            })
            .catch(() => undefined);
        }

        const last = newlyOverdue[newlyOverdue.length - 1];
        after = last ? last.id : after;
        return { selected: newlyOverdue.length, processed: newlyOverdue.length };
      });

      result.emitted += outcome.processed;
      if (outcome.truncated) result.truncated = true;
    });

    result.organizationsFailed = sweepResult.failed;
    if (result.truncated)
      this.logger.warn(
        `[crm-tasks] the ${MAX_PAGES}-page cap was hit with tasks still due in this hour — ` +
          "those task.overdue events are lost, not deferred: the window has moved on",
      );

    return result;
  }
}
