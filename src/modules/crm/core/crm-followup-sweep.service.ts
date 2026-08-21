import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { leadTasks, tasks } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";

export interface CrmFollowupSweepResult {
  due: number;
  overdue: number;
}

/**
 * REG-003. `crm.followup.due` and `crm.followup.overdue` were declared in the catalog but
 * nothing could fire them — both are time-derived, so there is no user action to hang them
 * off, and a rep has never been reminded that a follow-up came due.
 *
 * Like the Build sweep, this matches the day a task CROSSES its date rather than every
 * task currently past it: a range predicate would re-notify the whole backlog daily.
 *
 * BOTH task tables are swept. Follow-ups live on `lead_tasks` (against a lead) and on
 * `tasks` (against a deal or contact); covering only one silently loses half the
 * reminders, which is indistinguishable from the feature not working.
 *
 * `cron-crm-tasks.service.ts` also reads `tasks`, but it emits to the automation-studio
 * bus rather than to the notification engine — different mechanism, different purpose,
 * so this is not a duplicate notification.
 */
@Injectable()
export class CrmFollowupSweepService {
  private readonly logger = new Logger(CrmFollowupSweepService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async sweep(): Promise<CrmFollowupSweepResult> {
    const result: CrmFollowupSweepResult = { due: 0, overdue: 0 };

    await forEachOrg(this.db, "crm-followup-sweep", async (tx, orgId) => {
      const load = (offset: 0 | -1) =>
        tx
          .select({
            id: leadTasks.id,
            title: leadTasks.title,
            leadId: leadTasks.leadId,
            assigneeId: leadTasks.assigneeId,
          })
          .from(leadTasks)
          .where(
            and(
              eq(leadTasks.orgId, orgId),
              isNotNull(leadTasks.assigneeId),
              offset === 0
                ? sql`${leadTasks.dueDate} = current_date`
                : sql`${leadTasks.dueDate} = current_date - 1`,
            ),
          )
          .limit(500);

      // `tasks.dueDate` is a timestamptz, so it is compared by date rather than equality.
      const loadDealTasks = (offset: 0 | -1) =>
        tx
          .select({
            id: tasks.id,
            title: tasks.title,
            assigneeId: tasks.assigneeId,
          })
          .from(tasks)
          .where(
            and(
              eq(tasks.orgId, orgId),
              isNotNull(tasks.assigneeId),
              eq(tasks.status, "pending"),
              offset === 0
                ? sql`${tasks.dueDate}::date = current_date`
                : sql`${tasks.dueDate}::date = current_date - 1`,
            ),
          )
          .limit(500);

      const dueToday = await load(0);
      const overdue = await load(-1);
      const dealDueToday = await loadDealTasks(0);
      const dealOverdue = await loadDealTasks(-1);

      for (const task of dueToday) {
        if (!task.assigneeId) continue;
        await this.dispatch.emit({
          eventKey: "crm.followup.due",
          orgId,
          targetUserIds: [task.assigneeId],
          entityType: "lead_task",
          entityId: String(task.id),
          title: `Follow-up due today: ${task.title}`,
          message: "This follow-up is due today.",
          link: `/crm/leads/${task.leadId}`,
        });
        result.due += 1;
      }

      for (const task of overdue) {
        if (!task.assigneeId) continue;
        await this.dispatch.emit({
          eventKey: "crm.followup.overdue",
          orgId,
          targetUserIds: [task.assigneeId],
          entityType: "lead_task",
          entityId: String(task.id),
          title: `Follow-up overdue: ${task.title}`,
          message: "This follow-up was due yesterday and is still open.",
          link: `/crm/leads/${task.leadId}`,
        });
        result.overdue += 1;
      }

      for (const task of dealDueToday) {
        if (!task.assigneeId) continue;
        await this.dispatch.emit({
          eventKey: "crm.followup.due",
          orgId,
          targetUserIds: [task.assigneeId],
          entityType: "task",
          entityId: String(task.id),
          title: `Follow-up due today: ${task.title}`,
          message: "This follow-up is due today.",
          link: `/crm/tasks/${task.id}`,
        });
        result.due += 1;
      }

      for (const task of dealOverdue) {
        if (!task.assigneeId) continue;
        await this.dispatch.emit({
          eventKey: "crm.followup.overdue",
          orgId,
          targetUserIds: [task.assigneeId],
          entityType: "task",
          entityId: String(task.id),
          title: `Follow-up overdue: ${task.title}`,
          message: "This follow-up was due yesterday and is still open.",
          link: `/crm/tasks/${task.id}`,
        });
        result.overdue += 1;
      }
    });

    if (result.due > 0 || result.overdue > 0) {
      this.logger.log(
        `CRM_FOLLOWUP_SWEEP: ${result.due} due, ${result.overdue} overdue notification(s)`,
      );
    }
    return result;
  }
}
