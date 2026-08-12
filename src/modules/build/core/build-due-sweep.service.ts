import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";

export interface BuildDueSweepResult {
  dueSoon: number;
  overdue: number;
}

/**
 * REG-003. `build.ticket.due_soon` and `build.ticket.overdue` were declared in the
 * catalog but nothing could ever fire them: both are time-derived, so there is no user
 * action to hang them off. An assignee has therefore never been told a ticket was about
 * to slip or had already slipped.
 *
 * The sweep matches the day a ticket CROSSES a boundary, not every ticket currently past
 * one. That distinction is the whole design: a range predicate would have notified every
 * assignee about the entire historical backlog on the first run, and again every day
 * afterwards, which is how a notification system gets muted. Re-running the cron twice in
 * one day re-emits the same small set, and the dispatcher's own dedupe window absorbs it —
 * so no "already notified" column is needed, and there is no extra state to keep correct.
 */
@Injectable()
export class BuildDueSweepService {
  private readonly logger = new Logger(BuildDueSweepService.name);
  private static readonly DUE_SOON_DAYS = 2;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async sweep(): Promise<BuildDueSweepResult> {
    const result: BuildDueSweepResult = { dueSoon: 0, overdue: 0 };

    await forEachOrg(this.db, "build-due-sweep", async (tx, orgId) => {
      // Boundary, not range. Matching every ticket currently inside the window would
      // notify about the whole historical backlog on the first run — 5,716 tickets on
      // this database — and re-notify about all of them every day after. Each ticket
      // instead fires once, on the day it crosses.
      //
      // Date arithmetic with literal day counts, deliberately not bound parameters and
      // deliberately not make_interval:
      //   * `current_date + $n` fails outright — Postgres cannot type the operand, and
      //     the error is invisible from the endpoint because forEachOrg logs and continues.
      //   * `current_date - make_interval(...)` returns a TIMESTAMP, so comparing it to a
      //     date column casts every row and gives up the index on 203k tickets.
      // Both offsets are compile-time constants, so a literal is safe here.
      const entersWindow = sql.raw(`current_date + ${BuildDueSweepService.DUE_SOON_DAYS}`);
      const slippedYesterday = sql.raw("current_date - 1");

      // Unassigned tickets are skipped: there is no one to notify, and notifying the
      // whole project on every slipping ticket is how a notification system gets muted.
      const base = and(
        eq(tickets.orgId, orgId),
        isNull(tickets.deletedAt),
        isNotNull(tickets.dueDate),
        isNotNull(tickets.assigneeId),
        ne(tickets.status, "DONE"),
      );

      const dueSoon = await tx
        .select({
          id: tickets.id,
          title: tickets.title,
          dueDate: tickets.dueDate,
          assigneeId: tickets.assigneeId,
        })
        .from(tickets)
        .where(and(base, eq(tickets.dueDate, entersWindow)))
        .limit(500);

      const overdue = await tx
        .select({
          id: tickets.id,
          title: tickets.title,
          dueDate: tickets.dueDate,
          assigneeId: tickets.assigneeId,
        })
        .from(tickets)
        .where(and(base, eq(tickets.dueDate, slippedYesterday)))
        .limit(500);

      for (const ticket of dueSoon) {
        if (!ticket.assigneeId) continue;
        await this.dispatch.emit({
          eventKey: "build.ticket.due_soon",
          orgId,
          targetUserIds: [ticket.assigneeId],
          entityType: "ticket",
          entityId: String(ticket.id),
          title: `Due soon: ${ticket.title}`,
          message: `This ticket is due on ${ticket.dueDate}.`,
          link: `/build/tickets/${ticket.id}`,
        });
        result.dueSoon += 1;
      }

      for (const ticket of overdue) {
        if (!ticket.assigneeId) continue;
        await this.dispatch.emit({
          eventKey: "build.ticket.overdue",
          orgId,
          targetUserIds: [ticket.assigneeId],
          entityType: "ticket",
          entityId: String(ticket.id),
          title: `Overdue: ${ticket.title}`,
          message: `This ticket was due on ${ticket.dueDate} and is still open.`,
          link: `/build/tickets/${ticket.id}`,
        });
        result.overdue += 1;
      }
    });

    if (result.dueSoon > 0 || result.overdue > 0) {
      this.logger.log(
        `BUILD_DUE_SWEEP: ${result.dueSoon} due-soon, ${result.overdue} overdue notification(s)`,
      );
    }
    return result;
  }
}
