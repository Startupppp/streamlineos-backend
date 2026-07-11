import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  hrEffectiveDatedChanges,
  hrEmploymentHistory,
  hrEmployments,
  hrPeople,
} from "../../db/schema/hr/core-people";
import { hrAuditLogs } from "../../db/schema/hr/core-audit";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";

type TimelineEntry = {
  id: string;
  type: "status_transition" | "effective_change" | "audit";
  action: string;
  entityType: string;
  createdAt: Date;
  data: Record<string, unknown>;
};

@Injectable()
export class HrTimelineService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getTimeline(orgId: string, employmentId: number, opts: { page: number; limit: number }) {
    const { page, limit } = opts;

    const [history, changes, auditEntries] = await Promise.all([
      this.db
        .select()
        .from(hrEmploymentHistory)
        .where(
          and(
            eq(hrEmploymentHistory.orgId, orgId),
            eq(hrEmploymentHistory.employmentId, employmentId),
          ),
        )
        .orderBy(desc(hrEmploymentHistory.createdAt))
        .limit(100),

      this.db
        .select()
        .from(hrEffectiveDatedChanges)
        .where(
          and(
            eq(hrEffectiveDatedChanges.orgId, orgId),
            eq(hrEffectiveDatedChanges.employmentId, employmentId),
          ),
        )
        .orderBy(desc(hrEffectiveDatedChanges.createdAt))
        .limit(100),

      this.db
        .select()
        .from(hrAuditLogs)
        .where(
          and(
            eq(hrAuditLogs.orgId, orgId),
            eq(hrAuditLogs.entityType, "hr_employments"),
            eq(hrAuditLogs.entityId, String(employmentId)),
          ),
        )
        .orderBy(desc(hrAuditLogs.createdAt))
        .limit(100),
    ]);

    const entries: TimelineEntry[] = [
      ...history.map((h) => ({
        id: `history-${h.id}`,
        type: "status_transition" as const,
        action: `Status changed: ${h.fromStatus} → ${h.toStatus}`,
        entityType: "hr_employment_history",
        createdAt: h.createdAt,
        data: {
          fromStatus: h.fromStatus,
          toStatus: h.toStatus,
          reason: h.reason,
          notes: h.notes,
          effectiveDate: h.effectiveDate,
          createdBy: h.createdBy,
        },
      })),
      ...changes.map((c) => ({
        id: `change-${c.id}`,
        type: "effective_change" as const,
        action: `${c.changeType} change scheduled`,
        entityType: "hr_effective_dated_changes",
        createdAt: c.createdAt,
        data: {
          changeType: c.changeType,
          status: c.status,
          effectiveFrom: c.effectiveFrom,
          effectiveTo: c.effectiveTo,
          oldValue: c.oldValue,
          newValue: c.newValue,
          appliedAt: c.appliedAt,
        },
      })),
      ...auditEntries.map((a) => ({
        id: `audit-${a.id}`,
        type: "audit" as const,
        action: a.action,
        entityType: a.entityType,
        createdAt: a.createdAt,
        data: {
          before: a.before,
          after: a.after,
          actorId: a.actorId,
        },
      })),
    ];

    entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const offset = (page - 1) * limit;
    const paginated = entries.slice(offset, offset + limit);
    const total = entries.length;

    return {
      data: paginated,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getEmploymentByUserId(orgId: string, userId: string) {
    const person = await this.db
      .select({ id: hrPeople.id })
      .from(hrPeople)
      .where(and(eq(hrPeople.orgId, orgId), eq(hrPeople.userId, userId), isNull(hrPeople.deletedAt)))
      .limit(1);

    if (!person[0]) throw new NotFoundException("Employee not found");

    const employment = await this.db
      .select({
        id: hrEmployments.id,
        employeeNumber: hrEmployments.employeeNumber,
        lifecycleStatus: hrEmployments.lifecycleStatus,
        workerType: hrEmployments.workerType,
        departmentId: hrEmployments.departmentId,
        designation: hrEmployments.designation,
        joiningDate: hrEmployments.joiningDate,
      })
      .from(hrEmployments)
      .where(
        and(
          eq(hrEmployments.orgId, orgId),
          eq(hrEmployments.personId, person[0].id),
          eq(hrEmployments.isPrimary, true),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .limit(1);

    if (!employment[0]) throw new NotFoundException("Employment record not found");

    return employment[0];
  }

  async getHistory(
    orgId: string,
    employmentId: number,
    type: "manager" | "department",
    opts: { page: number; limit: number },
  ) {
    const { page, limit } = opts;
    const offset = (page - 1) * limit;

    const changeType = type === "manager" ? "manager" : "department";

    const allRows = await this.db
      .select()
      .from(hrEffectiveDatedChanges)
      .where(
        and(
          eq(hrEffectiveDatedChanges.orgId, orgId),
          eq(hrEffectiveDatedChanges.employmentId, employmentId),
          eq(hrEffectiveDatedChanges.changeType, changeType),
        ),
      )
      .orderBy(desc(hrEffectiveDatedChanges.effectiveFrom));

    const total = allRows.length;
    const data = allRows.slice(offset, offset + limit);

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
