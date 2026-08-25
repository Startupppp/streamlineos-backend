import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { listCompatibleHolidays } from "../../db/compat/organization-holidays";
import { CalendarSourceRegistry } from "../calendar/calendar-source.registry";
import type {
  CalendarEventProjection,
  CalendarEventSource,
  CalendarSourceContext,
} from "../calendar/calendar-event-source";
import { HrCalendarSource } from "./hr-calendar-source";

abstract class HrProjectionSource implements CalendarEventSource, OnModuleInit {
  abstract readonly key: string;
  abstract readonly label: string;
  readonly module = "hr";

  constructor(
    protected readonly legacy: HrCalendarSource,
    private readonly registry: CalendarSourceRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async load(ctx: CalendarSourceContext): Promise<CalendarEventProjection[]> {
    const source = this.key === "hr-leaves"
      ? "leave"
      : this.key === "hr-interviews"
        ? "interview"
        : "attendance";
    const projections = await this.legacy.loadSource(ctx, source);
    return projections.filter((projection) => this.owns(projection));
  }

  protected abstract owns(projection: CalendarEventProjection): boolean;
}

@Injectable()
export class HrLeaveCalendarSource extends HrProjectionSource {
  readonly key = "hr-leaves";
  readonly label = "Leaves";

  protected owns(projection: CalendarEventProjection): boolean {
    return projection.meta["source"] === "leave";
  }
}

@Injectable()
export class HrInterviewCalendarSource extends HrProjectionSource {
  readonly key = "hr-interviews";
  readonly label = "Interviews";

  protected owns(projection: CalendarEventProjection): boolean {
    return projection.meta["source"] === "interview";
  }
}

@Injectable()
export class HrAttendanceCalendarSource extends HrProjectionSource {
  readonly key = "hr-attendance";
  readonly label = "Attendance";

  protected owns(projection: CalendarEventProjection): boolean {
    return projection.meta["source"] === "attendance";
  }
}

@Injectable()
export class HrHolidayCalendarSource implements CalendarEventSource, OnModuleInit {
  readonly key = "hr-holidays";
  readonly label = "Holidays";
  readonly module = "hr";

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: CalendarSourceRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async load(ctx: CalendarSourceContext): Promise<CalendarEventProjection[]> {
    const rows = await listCompatibleHolidays(
      this.db,
      ctx.orgId,
      ctx.start.toISOString().slice(0, 10),
      ctx.end.toISOString().slice(0, 10),
    );

    return rows.map((holiday) => {
      const day = new Date(`${holiday.date}T12:00:00.000Z`);
      return {
        id: `holiday-${holiday.id}`,
        title: holiday.name,
        start: day,
        end: day,
        allDay: true,
        color: "purple",
        category: "holiday",
        meta: { source: "holiday" },
      };
    });
  }
}
