import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { projectMembers, projects, tickets } from "../../db/schema";
import type {
  CalendarEventProjection,
  CalendarEventSource,
  CalendarSourceContext,
} from "../calendar/calendar-event-source";

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class BuildCalendarSource implements CalendarEventSource {
  readonly key = "build";
  readonly label = "Build";
  readonly module = "build";

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async load(ctx: CalendarSourceContext): Promise<CalendarEventProjection[]> {
    const { orgId, userId, start, end } = ctx;

    const rows = await this.db
      .select({
        id: tickets.id,
        title: tickets.title,
        dueDate: tickets.dueDate,
        status: tickets.status,
        ticketNumber: tickets.ticketNumber,
        projectId: projects.id,
        projectKey: projects.key,
      })
      .from(tickets)
      .innerJoin(projects, eq(tickets.projectId, projects.id))
      .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
      .where(
        and(
          eq(tickets.orgId, orgId),
          eq(projectMembers.userId, userId),
          isNotNull(tickets.dueDate),
          gte(tickets.dueDate, dateOnly(start)),
          lte(tickets.dueDate, dateOnly(end)),
        ),
      );

    const projections: CalendarEventProjection[] = [];
    for (const row of rows) {
      if (row.dueDate === null) continue;
      const date = new Date(row.dueDate);
      projections.push({
        id: `ticket-${row.id}`,
        title: `${row.projectKey}-${row.ticketNumber}: ${row.title}`,
        start: date,
        end: date,
        allDay: true,
        color: "blue",
        category: "task",
        meta: {
          source: "task",
          entityType: "ticket",
          entityId: String(row.id),
          projectId: row.projectId,
        },
      });
    }
    return projections;
  }
}
