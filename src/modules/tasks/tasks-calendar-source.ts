import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { tasks } from "../../db/schema";
import type {
  CalendarEventProjection,
  CalendarEventSource,
  CalendarSourceContext,
} from "../calendar/calendar-event-source";
import { CalendarSourceRegistry } from "../calendar/calendar-source.registry";

@Injectable()
export class TasksCalendarSource implements CalendarEventSource, OnModuleInit {
  readonly key = "tasks";
  readonly label = "Tasks";
  readonly module = "tasks";

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: CalendarSourceRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async load(ctx: CalendarSourceContext): Promise<CalendarEventProjection[]> {
    const { orgId, userId, start, end } = ctx;

    const rows = await this.db
      .select({
        id: tasks.id,
        title: tasks.title,
        dueDate: tasks.dueDate,
        status: tasks.status,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.orgId, orgId),
          eq(tasks.assigneeId, userId),
          isNotNull(tasks.dueDate),
          gte(tasks.dueDate, start),
          lte(tasks.dueDate, end),
        ),
      );

    const projections: CalendarEventProjection[] = [];
    for (const row of rows) {
      if (row.dueDate === null) continue;
      projections.push({
        id: `task-${row.id}`,
        title: row.title,
        start: row.dueDate,
        end: row.dueDate,
        allDay: true,
        color: row.status === "completed" ? "gray" : "red",
        category: "task",
        meta: { source: "task" },
      });
    }
    return projections;
  }
}
