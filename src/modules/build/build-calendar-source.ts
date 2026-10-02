import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { and, eq, gte, isNotNull, isNull, lte } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { organizationMembers, projects, tickets } from "../../db/schema";
import type {
  CalendarEventProjection,
  CalendarEventSource,
  CalendarSourceLoadResult,
  CalendarSourceContext,
} from "../calendar/calendar-event-source";
import { CalendarSourceRegistry, CALENDAR_PER_SOURCE_CAP } from "../calendar/calendar-source.registry";
import { reachableTicketProjectsSql } from "./reachability/project-reachability";

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class BuildCalendarSource implements CalendarEventSource, OnModuleInit {
  readonly key = "build";
  readonly label = "Build";
  readonly module = "build";

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: CalendarSourceRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async load(ctx: CalendarSourceContext): Promise<CalendarSourceLoadResult> {
    const { orgId, userId, start, end } = ctx;

    const [memberRow] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .limit(1);
    if (!memberRow) return { events: [], truncated: false };

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
      .innerJoin(projects, and(eq(tickets.projectId, projects.id), eq(projects.orgId, orgId)))
      .where(
        and(
          eq(tickets.orgId, orgId),
          reachableTicketProjectsSql(orgId, memberRow.id),
          isNotNull(tickets.dueDate),
          gte(tickets.dueDate, dateOnly(start)),
          lte(tickets.dueDate, dateOnly(end)),
          isNull(tickets.deletedAt),
          isNull(projects.deletedAt),
        ),
      )
      .limit(CALENDAR_PER_SOURCE_CAP + 1);

    const projections: CalendarEventProjection[] = [];
    for (const row of rows.slice(0, CALENDAR_PER_SOURCE_CAP)) {
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
    return { events: projections, truncated: rows.length > CALENDAR_PER_SOURCE_CAP };
  }
}
