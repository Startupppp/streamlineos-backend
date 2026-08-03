import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { hrEventStream } from "../../../../db/schema/hr/enterprise-ops";
import type { ListEventsInput, ExportEventsInput } from "../dto/event-stream.schemas";

const SENSITIVE_KEYS = new Set(["salary", "gross", "net", "medical_note", "confidential"]);

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    const lower = k.toLowerCase();
    if (SENSITIVE_KEYS.has(lower) || lower.includes("salary") || lower.includes("medical")) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const HR_EVENT_CATALOG: Array<{ eventType: string; description: string; entityTypes: string[] }> = [
  { eventType: "employee.created", description: "New employee profile created", entityTypes: ["employee"] },
  { eventType: "employee.updated", description: "Employee profile updated", entityTypes: ["employee"] },
  { eventType: "employee.exited", description: "Employee marked as exited", entityTypes: ["employee"] },
  { eventType: "leave.requested", description: "Leave application submitted", entityTypes: ["leave"] },
  { eventType: "leave.approved", description: "Leave approved", entityTypes: ["leave"] },
  { eventType: "leave.rejected", description: "Leave rejected", entityTypes: ["leave"] },
  { eventType: "payroll.run.started", description: "Payroll run initiated", entityTypes: ["payroll_run"] },
  { eventType: "payroll.run.completed", description: "Payroll run completed", entityTypes: ["payroll_run"] },
  { eventType: "attendance.marked", description: "Attendance recorded", entityTypes: ["attendance"] },
  { eventType: "accommodation.approved", description: "Accommodation request approved", entityTypes: ["accommodation"] },
  { eventType: "emergency.created", description: "Emergency event declared", entityTypes: ["emergency_event"] },
  { eventType: "access.provisioned", description: "System access provisioned", entityTypes: ["access_provisioning"] },
  { eventType: "simulation.run", description: "HR simulation executed", entityTypes: ["simulation"] },
];

@Injectable()
export class EventStreamService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async appendEvent(
    orgId: string,
    eventType: string,
    entityType: string,
    entityId: string,
    payload: Record<string, unknown>,
    actor?: string,
  ): Promise<void> {
    const sanitized = sanitizePayload(payload);
    await this.db.insert(hrEventStream).values({
      orgId,
      eventType,
      entityType,
      entityId,
      payload: sanitized,
      actorUserId: actor ?? null,
      occurredAt: new Date(),
    });
  }

  async listEvents(orgId: string, input: ListEventsInput) {
    const { page, limit, eventType, entityType, entityId, fromDate, toDate } = input;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrEventStream.orgId, orgId)];
    if (eventType) conditions.push(eq(hrEventStream.eventType, eventType));
    if (entityType) conditions.push(eq(hrEventStream.entityType, entityType));
    if (entityId) conditions.push(eq(hrEventStream.entityId, entityId));
    if (fromDate) conditions.push(gte(hrEventStream.occurredAt, new Date(fromDate)));
    if (toDate) conditions.push(lte(hrEventStream.occurredAt, new Date(toDate)));

    const where = and(...conditions);

    const [rows, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrEventStream)
        .where(where)
        .orderBy(desc(hrEventStream.occurredAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrEventStream).where(where),
    ]);

    const total = totalResult[0]?.total ?? 0;
    return { data: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  getDataDictionary() {
    return {
      catalog: HR_EVENT_CATALOG,
      sanitizedFields: Array.from(SENSITIVE_KEYS),
      immutable: true,
      note: "Event stream is append-only. No updates or deletes are permitted.",
    };
  }

  getMetricDefinitions() {
    return {
      metrics: [
        { name: "events_per_day", description: "Total HR events per day", aggregation: "count" },
        { name: "employee_churn_rate", description: "Exits / headcount per period", aggregation: "ratio" },
        { name: "leave_utilization", description: "Leave taken / entitlement", aggregation: "ratio" },
        { name: "provisioning_lag", description: "Time from trigger to completed provisioning", aggregation: "avg_duration" },
      ],
    };
  }

  async exportEvents(orgId: string, input: ExportEventsInput) {
    const { page, limit, eventType, entityType, fromDate, toDate } = input;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrEventStream.orgId, orgId)];
    if (eventType) conditions.push(eq(hrEventStream.eventType, eventType));
    if (entityType) conditions.push(eq(hrEventStream.entityType, entityType));
    if (fromDate) conditions.push(gte(hrEventStream.occurredAt, new Date(fromDate)));
    if (toDate) conditions.push(lte(hrEventStream.occurredAt, new Date(toDate)));

    const where = and(...conditions);

    const [rows, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrEventStream)
        .where(where)
        .orderBy(desc(hrEventStream.occurredAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrEventStream).where(where),
    ]);

    const total = totalResult[0]?.total ?? 0;
    return {
      exportedAt: new Date().toISOString(),
      data: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
