import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import {
  hrEffectiveDatedChanges,
  hrEmploymentHistory,
  hrEmployments,
  hrPeople,
} from "../../db/schema/hr/core-people";
import { hrAuditLogs } from "../../db/schema/hr/core-audit";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { PersonEmploymentSyncService } from "./person-employment-sync.service";

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
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly personEmploymentSync: PersonEmploymentSyncService,
  ) {}

  async getTimeline(orgId: string, employmentId: number, opts: { page: number; limit: number }) {
    const cappedLimit = Math.min(opts.limit, 100);
    const { page } = opts;
    const offset = (page - 1) * cappedLimit;
    const fetchBound = offset + cappedLimit;

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
        .limit(fetchBound),

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
        .limit(fetchBound),

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
        .limit(fetchBound),
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

    const total = entries.length;
    const paginated = entries.slice(offset, offset + cappedLimit);

    return {
      data: paginated,
      pagination: { page, limit: cappedLimit, total, totalPages: Math.ceil(total / cappedLimit) },
    };
  }

  async getEmploymentByUserId(orgId: string, userId: string) {
    const load = async () => {
      const [row] = await this.db
        .select({
          id: hrEmployments.id,
          personId: hrEmployments.personId,
          employeeNumber: hrEmployments.employeeNumber,
          lifecycleStatus: hrEmployments.lifecycleStatus,
          workerType: hrEmployments.workerType,
          departmentId: hrEmployments.departmentId,
          designation: hrEmployments.designation,
          joiningDate: hrEmployments.joiningDate,
          probationEndDate: hrEmployments.probationEndDate,
          confirmationDate: hrEmployments.confirmationDate,
          isPrimary: hrEmployments.isPrimary,
          personFirstName: hrPeople.firstName,
          personLastName: hrPeople.lastName,
          personWorkEmail: hrPeople.workEmail,
        })
        .from(hrPeople)
        .innerJoin(
          hrEmployments,
          and(
            eq(hrEmployments.personId, hrPeople.id),
            eq(hrEmployments.orgId, orgId),
            eq(hrEmployments.isPrimary, true),
            isNull(hrEmployments.deletedAt),
          ),
        )
        .where(
          and(
            eq(hrPeople.orgId, orgId),
            eq(hrPeople.userId, userId),
            isNull(hrPeople.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    };

    let row = await load();
    if (!row) {
      await this.personEmploymentSync.ensureFromUserId(orgId, userId, userId);
      row = await load();
    }
    if (!row) throw new NotFoundException("Employee not found");

    return row;
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
    const where = and(
      eq(hrEffectiveDatedChanges.orgId, orgId),
      eq(hrEffectiveDatedChanges.employmentId, employmentId),
      eq(hrEffectiveDatedChanges.changeType, changeType),
    );

    const [data, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrEffectiveDatedChanges)
        .where(where)
        .orderBy(desc(hrEffectiveDatedChanges.effectiveFrom))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrEffectiveDatedChanges).where(where),
    ]);

    const total = totalResult[0]?.total ?? 0;

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
