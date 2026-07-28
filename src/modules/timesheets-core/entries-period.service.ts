import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  timesheets,
  timesheetPeriods,
  timesheetSettings,
  tickets,
} from "../../db/schema";
import { weekRange } from "./lib/period.helpers";

@Injectable()
export class EntriesPeriodService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async loadSettings(orgId: string) {
    const [settings] = await this.db
      .select()
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, orgId))
      .limit(1);
    return settings;
  }

  async getOrCreatePeriod(
    orgId: string,
    userId: string,
    date: string,
    workWeekStart: number,
    dbOrTx: Pick<Db, "select" | "insert"> = this.db,
  ): Promise<number> {
    const range = weekRange(new Date(date + "T12:00:00"), workWeekStart);
    const matchesRange = and(
      eq(timesheetPeriods.orgId, orgId),
      eq(timesheetPeriods.userId, userId),
      eq(timesheetPeriods.periodStart, range.start),
      eq(timesheetPeriods.periodEnd, range.end),
    );

    const [existing] = await dbOrTx
      .select({ id: timesheetPeriods.id })
      .from(timesheetPeriods)
      .where(matchesRange)
      .limit(1);

    if (existing) return existing.id;

    const inserted = await dbOrTx
      .insert(timesheetPeriods)
      .values({
        orgId,
        userId,
        periodStart: range.start,
        periodEnd: range.end,
        status: "OPEN",
        totalHours: "0",
        billableHours: "0",
        nonBillableHours: "0",
      })
      .onConflictDoNothing()
      .returning({ id: timesheetPeriods.id });

    if (inserted[0]) return inserted[0].id;

    const [refetch] = await dbOrTx
      .select({ id: timesheetPeriods.id })
      .from(timesheetPeriods)
      .where(matchesRange)
      .limit(1);

    if (!refetch) {
      throw new ConflictException(
        "Could not resolve the timesheet period for this date",
      );
    }
    return refetch.id;
  }

  async recomputePeriodTotals(
    orgId: string,
    periodId: number,
    dbOrTx: Pick<Db, "select" | "update"> = this.db,
  ): Promise<void> {
    const [sums] = await dbOrTx
      .select({
        total: sql<string>`COALESCE(SUM(hours::numeric), 0)::text`,
        billable: sql<string>`COALESCE(SUM(CASE WHEN is_billable THEN hours::numeric ELSE 0 END), 0)::text`,
        nonBillable: sql<string>`COALESCE(SUM(CASE WHEN NOT is_billable THEN hours::numeric ELSE 0 END), 0)::text`,
      })
      .from(timesheets)
      .where(
        and(
          eq(timesheets.timesheetPeriodId, periodId),
          eq(timesheets.orgId, orgId),
          isNull(timesheets.voidedAt),
        ),
      );

    await dbOrTx
      .update(timesheetPeriods)
      .set({
        totalHours: sums?.total ?? "0",
        billableHours: sums?.billable ?? "0",
        nonBillableHours: sums?.nonBillable ?? "0",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(timesheetPeriods.id, periodId),
          eq(timesheetPeriods.orgId, orgId),
        ),
      );
  }

  async syncTicketTimeSpent(
    dbOrTx: Pick<Db, "select" | "update">,
    orgId: string,
    ticketId: number,
  ): Promise<void> {
    const [ticketHours] = await dbOrTx
      .select({
        total: sql<number>`COALESCE(SUM(hours::numeric), 0)`,
      })
      .from(timesheets)
      .where(
        and(
          eq(timesheets.ticketId, ticketId),
          eq(timesheets.orgId, orgId),
          isNull(timesheets.voidedAt),
        ),
      );
    await dbOrTx
      .update(tickets)
      .set({ timeSpent: (ticketHours?.total ?? 0).toString() })
      .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)));
  }
}
