import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  payrollCalendarEvents,
  payrollPolicies,
  payrollPolicyVersions,
} from "../../../db/schema";
import type { PayrollPolicyConfig } from "../payroll.types";

type CalendarEventStatus = "upcoming" | "due" | "overdue";

type CalendarEventRow = {
  id: number;
  orgId: string;
  month: string | null;
  type: string;
  date: string;
  title: string;
  status: CalendarEventStatus;
};

type CalendarEventInsert = typeof payrollCalendarEvents.$inferInsert;
type CalendarEventSelect = typeof payrollCalendarEvents.$inferSelect;

function deriveStatus(dateStr: string): CalendarEventStatus {
  const today = new Date();
  const eventDate = new Date(dateStr);
  if (eventDate < today) return "overdue";
  if (eventDate <= new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000)) return "due";
  return "upcoming";
}

function toRow(row: CalendarEventSelect): CalendarEventRow {
  return {
    id: row.id,
    orgId: row.orgId,
    month: row.month,
    type: row.type,
    date: row.date,
    title: row.title,
    status: deriveStatus(row.date),
  };
}

@Injectable()
export class CalendarService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, from?: string, to?: string): Promise<CalendarEventRow[]> {
    const base = eq(payrollCalendarEvents.orgId, orgId);
    const whereClause =
      from || to
        ? and(
            base,
            from ? gte(payrollCalendarEvents.date, from) : undefined,
            to ? lte(payrollCalendarEvents.date, to) : undefined,
          )
        : base;

    const rows = await this.db
      .select()
      .from(payrollCalendarEvents)
      .where(whereClause)
      .orderBy(asc(payrollCalendarEvents.date));

    return rows.map(toRow);
  }

  async create(
    orgId: string,
    actorId: string,
    data: { type: string; date: string; title: string; month?: string },
  ): Promise<CalendarEventRow> {
    const [row] = await this.db
      .insert(payrollCalendarEvents)
      .values({
        orgId,
        type: data.type as CalendarEventInsert["type"],
        date: data.date,
        title: data.title,
        month: data.month ?? null,
        createdBy: actorId,
      })
      .returning();
    return toRow(row);
  }

  async update(
    orgId: string,
    eventId: number,
    data: { type?: string; date?: string; title?: string; month?: string },
  ): Promise<CalendarEventRow> {
    const [existing] = await this.db
      .select({ id: payrollCalendarEvents.id })
      .from(payrollCalendarEvents)
      .where(and(eq(payrollCalendarEvents.id, eventId), eq(payrollCalendarEvents.orgId, orgId)));

    if (!existing) throw new NotFoundException("Calendar event not found");

    const patch: {
      type?: CalendarEventInsert["type"];
      date?: string;
      title?: string;
      month?: string | null;
      updatedAt?: Date;
    } = { updatedAt: new Date() };

    if (data.type !== undefined) patch.type = data.type as CalendarEventInsert["type"];
    if (data.date !== undefined) patch.date = data.date;
    if (data.title !== undefined) patch.title = data.title;
    if (data.month !== undefined) patch.month = data.month;

    const [updated] = await this.db
      .update(payrollCalendarEvents)
      .set(patch)
      .where(eq(payrollCalendarEvents.id, eventId))
      .returning();

    return toRow(updated);
  }

  async remove(orgId: string, eventId: number): Promise<{ deleted: true }> {
    const [existing] = await this.db
      .select({ id: payrollCalendarEvents.id })
      .from(payrollCalendarEvents)
      .where(and(eq(payrollCalendarEvents.id, eventId), eq(payrollCalendarEvents.orgId, orgId)));

    if (!existing) throw new NotFoundException("Calendar event not found");

    await this.db.delete(payrollCalendarEvents).where(eq(payrollCalendarEvents.id, eventId));

    return { deleted: true };
  }

  async generateMonth(orgId: string, month: string): Promise<{ generated: number; month: string }> {
    const rows = await this.db
      .select({ policy: payrollPolicies, version: payrollPolicyVersions })
      .from(payrollPolicies)
      .innerJoin(payrollPolicyVersions, eq(payrollPolicies.activeVersionId, payrollPolicyVersions.id))
      .where(eq(payrollPolicies.orgId, orgId))
      .limit(1);

    if (rows.length === 0) return { generated: 0, month };

    const { policy, version } = rows[0];
    const config = version.config as PayrollPolicyConfig;
    const policyPayDay = policy.payDay;

    const pad = (n: number) => String(n).padStart(2, "0");
    const payDateStr = `${month}-${pad(policyPayDay)}`;
    const publishDate = new Date(
      new Date(payDateStr).getTime() + config.calendar.publishOffsetDays * 24 * 60 * 60 * 1000,
    );
    const publishDateStr = publishDate.toISOString().slice(0, 10);

    type EventDef = { type: CalendarEventInsert["type"]; date: string; title: string };

    const eventDefs: EventDef[] = [
      {
        type: "ATTENDANCE_CUTOFF",
        date: `${month}-${pad(config.calendar.attendanceCutoffDay)}`,
        title: "Attendance Cutoff",
      },
      {
        type: "PREVIEW_DUE",
        date: `${month}-${pad(config.calendar.previewDay)}`,
        title: "Payroll Preview Due",
      },
      {
        type: "APPROVAL_DEADLINE",
        date: `${month}-${pad(config.calendar.approvalDeadlineDay)}`,
        title: "Payroll Approval Deadline",
      },
      { type: "PAY_DATE", date: payDateStr, title: "Pay Date" },
      { type: "PUBLISH_DATE", date: publishDateStr, title: "Payslip Publish Date" },
    ];

    let generated = 0;

    for (const def of eventDefs) {
      const [existing] = await this.db
        .select({ id: payrollCalendarEvents.id })
        .from(payrollCalendarEvents)
        .where(
          and(
            eq(payrollCalendarEvents.orgId, orgId),
            eq(payrollCalendarEvents.month, month),
            eq(payrollCalendarEvents.type, def.type),
          ),
        );

      if (existing) continue;

      await this.db.insert(payrollCalendarEvents).values({
        orgId,
        month,
        type: def.type,
        date: def.date,
        title: def.title,
      });

      generated++;
    }

    return { generated, month };
  }
}
