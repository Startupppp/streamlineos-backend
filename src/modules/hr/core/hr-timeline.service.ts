import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, isNull, lte, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import {
  hrEffectiveDatedChanges,
  hrEmploymentHistory,
  hrEmployments,
  hrPeople,
} from "../../../db/schema/hr/core-people";
import { hrAuditLogs } from "../../../db/schema/hr/core-audit";
import { organizationMembers } from "../../../db/schema/common/auth";
import { organizationPeople } from "../../../db/schema/directory/organization-people";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import { primaryEmploymentOfPerson } from "../../directory/employment-query";

type TimelineEntry = {
  id: string;
  type: "status_transition" | "effective_change" | "audit";
  action: string;
  entityType: string;
  createdAt: Date;
  data: Record<string, unknown>;
};

type TimelineSource = "history" | "change" | "audit";

type TimelinePosition = {
  createdAt: string;
  sourceRecordId: number;
};

type TimelineCursor = {
  version: 1;
  asOf: string;
  positions: Partial<Record<TimelineSource, TimelinePosition>>;
};

type TimelineCandidate = TimelineEntry & {
  source: TimelineSource;
  sourceId: number;
  sourceRank: number;
};

function decodeTimelineCursor(value: string | undefined): TimelineCursor {
  if (!value) {
    return { version: 1, asOf: new Date().toISOString(), positions: {} };
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<TimelineCursor>;
    const asOf = new Date(parsed.asOf ?? "");
    if (
      parsed.version !== 1 ||
      Number.isNaN(asOf.getTime()) ||
      asOf.getTime() > Date.now() + 60_000 ||
      !parsed.positions ||
      typeof parsed.positions !== "object"
    ) {
      throw new Error("invalid cursor");
    }

    for (const source of ["history", "change", "audit"] as const) {
      const position = parsed.positions[source];
      if (!position) continue;
      const createdAt = new Date(position.createdAt);
      if (
        Number.isNaN(createdAt.getTime()) ||
        !Number.isSafeInteger(position.sourceRecordId) ||
        position.sourceRecordId < 1
      ) {
        throw new Error("invalid cursor position");
      }
    }

    return parsed as TimelineCursor;
  } catch {
    throw new BadRequestException("The timeline cursor is invalid or expired.");
  }
}

function encodeTimelineCursor(cursor: TimelineCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function afterPosition(
  createdAt: SQLWrapper,
  sourceRecordId: SQLWrapper,
  position: TimelinePosition | undefined,
) {
  if (!position) return undefined;
  const date = new Date(position.createdAt);
  return sql<boolean>`(
    ${createdAt} < ${date}
    OR (${createdAt} = ${date} AND ${sourceRecordId} < ${position.sourceRecordId})
  )`;
}

function compareTimelineEntries(leftEntry: TimelineCandidate, rightEntry: TimelineCandidate) {
  const time = rightEntry.createdAt.getTime() - leftEntry.createdAt.getTime();
  if (time !== 0) return time;
  const source = leftEntry.sourceRank - rightEntry.sourceRank;
  if (source !== 0) return source;
  return rightEntry.sourceId - leftEntry.sourceId;
}

@Injectable()
export class HrTimelineService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async assertEmploymentVisible(
    orgId: string,
    actorUserId: string,
    employmentId: number,
    scope: DataScope,
  ): Promise<void> {
    const [visible] = await this.db
      .select({ id: hrEmployments.id })
      .from(hrEmployments)
      .innerJoin(
        hrPeople,
        and(
          eq(hrPeople.id, hrEmployments.personId),
          eq(hrPeople.orgId, orgId),
          isNull(hrPeople.deletedAt),
        ),
      )
      .where(
        and(
          eq(hrEmployments.id, employmentId),
          eq(hrEmployments.orgId, orgId),
          isNull(hrEmployments.deletedAt),
          applyScope(scope, orgId, actorUserId, { ownerColumn: hrPeople.userId }),
        ),
      )
      .limit(1);

    if (!visible) throw new NotFoundException("Employment not found");
  }

  async getTimeline(
    orgId: string,
    actorUserId: string,
    employmentId: number,
    scope: DataScope,
    opts: { cursor?: string; limit: number },
  ) {
    await this.assertEmploymentVisible(orgId, actorUserId, employmentId, scope);
    const cappedLimit = Math.min(opts.limit, 100);
    const cursor = decodeTimelineCursor(opts.cursor);
    const asOf = new Date(cursor.asOf);
    const fetchLimit = cappedLimit + 1;

    const [history, changes, auditEntries] = await Promise.all([
      this.db
        .select({
          id: hrEmploymentHistory.id,
          fromStatus: hrEmploymentHistory.fromStatus,
          toStatus: hrEmploymentHistory.toStatus,
          reason: hrEmploymentHistory.reason,
          notes: hrEmploymentHistory.notes,
          effectiveDate: hrEmploymentHistory.effectiveDate,
          createdBy: hrEmploymentHistory.createdBy,
          createdAt: hrEmploymentHistory.createdAt,
        })
        .from(hrEmploymentHistory)
        .where(
          and(
            eq(hrEmploymentHistory.orgId, orgId),
            eq(hrEmploymentHistory.employmentId, employmentId),
            lte(hrEmploymentHistory.createdAt, asOf),
            afterPosition(
              hrEmploymentHistory.createdAt,
              hrEmploymentHistory.id,
              cursor.positions.history,
            ),
          ),
        )
        .orderBy(
          desc(hrEmploymentHistory.createdAt),
          desc(hrEmploymentHistory.id),
        )
        .limit(fetchLimit),

      this.db
        .select({
          id: hrEffectiveDatedChanges.id,
          changeType: hrEffectiveDatedChanges.changeType,
          status: hrEffectiveDatedChanges.status,
          effectiveFrom: hrEffectiveDatedChanges.effectiveFrom,
          effectiveTo: hrEffectiveDatedChanges.effectiveTo,
          appliedAt: hrEffectiveDatedChanges.appliedAt,
          createdAt: hrEffectiveDatedChanges.createdAt,
        })
        .from(hrEffectiveDatedChanges)
        .where(
          and(
            eq(hrEffectiveDatedChanges.orgId, orgId),
            eq(hrEffectiveDatedChanges.employmentId, employmentId),
            lte(hrEffectiveDatedChanges.createdAt, asOf),
            afterPosition(
              hrEffectiveDatedChanges.createdAt,
              hrEffectiveDatedChanges.id,
              cursor.positions.change,
            ),
          ),
        )
        .orderBy(
          desc(hrEffectiveDatedChanges.createdAt),
          desc(hrEffectiveDatedChanges.id),
        )
        .limit(fetchLimit),

      this.db
        .select({
          id: hrAuditLogs.id,
          action: hrAuditLogs.action,
          entityType: hrAuditLogs.entityType,
          actorId: hrAuditLogs.actorId,
          createdAt: hrAuditLogs.createdAt,
        })
        .from(hrAuditLogs)
        .where(
          and(
            eq(hrAuditLogs.orgId, orgId),
            eq(hrAuditLogs.entityType, "hr_employments"),
            eq(hrAuditLogs.entityId, String(employmentId)),
            lte(hrAuditLogs.createdAt, asOf),
            afterPosition(
              hrAuditLogs.createdAt,
              hrAuditLogs.id,
              cursor.positions.audit,
            ),
          ),
        )
        .orderBy(desc(hrAuditLogs.createdAt), desc(hrAuditLogs.id))
        .limit(fetchLimit),
    ]);

    const entries: TimelineCandidate[] = [
      ...history.map((historyEntry) => ({
        id: `history-${historyEntry.id}`,
        type: "status_transition" as const,
        action: `Status changed: ${historyEntry.fromStatus} → ${historyEntry.toStatus}`,
        entityType: "hr_employment_history",
        createdAt: historyEntry.createdAt,
        source: "history" as const,
        sourceId: historyEntry.id,
        sourceRank: 0,
        data: {
          fromStatus: historyEntry.fromStatus,
          toStatus: historyEntry.toStatus,
          reason: historyEntry.reason,
          notes: historyEntry.notes,
          effectiveDate: historyEntry.effectiveDate,
          createdBy: historyEntry.createdBy,
        },
      })),
      ...changes.map((effectiveChange) => ({
        id: `change-${effectiveChange.id}`,
        type: "effective_change" as const,
        action: `${effectiveChange.changeType} change scheduled`,
        entityType: "hr_effective_dated_changes",
        createdAt: effectiveChange.createdAt,
        source: "change" as const,
        sourceId: effectiveChange.id,
        sourceRank: 1,
        data: {
          changeType: effectiveChange.changeType,
          status: effectiveChange.status,
          effectiveFrom: effectiveChange.effectiveFrom,
          effectiveTo: effectiveChange.effectiveTo,
          appliedAt: effectiveChange.appliedAt,
        },
      })),
      ...auditEntries.map((auditEntry) => ({
        id: `audit-${auditEntry.id}`,
        type: "audit" as const,
        action: auditEntry.action,
        entityType: auditEntry.entityType,
        createdAt: auditEntry.createdAt,
        source: "audit" as const,
        sourceId: auditEntry.id,
        sourceRank: 2,
        data: {
          actorId: auditEntry.actorId,
        },
      })),
    ];

    entries.sort(compareTimelineEntries);
    const pageEntries = entries.slice(0, cappedLimit);
    const hasMore = entries.length > cappedLimit;
    const nextPositions = { ...cursor.positions };
    for (const entry of pageEntries) {
      nextPositions[entry.source] = {
        createdAt: entry.createdAt.toISOString(),
        sourceRecordId: entry.sourceId,
      };
    }
    const data = pageEntries.map(
      ({ source: _source, sourceId: _sourceId, sourceRank: _rank, ...entry }) =>
        entry,
    );

    return {
      data,
      pageInfo: {
        limit: cappedLimit,
        hasMore,
        nextCursor: hasMore
          ? encodeTimelineCursor({ ...cursor, positions: nextPositions })
          : null,
      },
    };
  }

  async getEmploymentByUserId(
    orgId: string,
    actorUserId: string,
    userId: string,
    scope: DataScope,
  ) {
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
        personFirstName: organizationPeople.firstName,
        personLastName: organizationPeople.lastName,
        personWorkEmail: organizationPeople.workEmail,
      })
      .from(hrPeople)
      .innerJoin(
        organizationPeople,
        and(
          eq(organizationPeople.organizationId, hrPeople.orgId),
          eq(organizationPeople.organizationPersonId, hrPeople.organizationPersonId),
        ),
      )
      .innerJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, hrPeople.userId),
        ),
      )
      .where(
        and(
          eq(hrPeople.orgId, orgId),
          eq(hrPeople.userId, userId),
          isNull(hrPeople.deletedAt),
          applyScope(scope, orgId, actorUserId, {
            ownerColumn: organizationMembers.userId,
          }),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("Employee not found");

    return row;
  }

  async getHistory(
    orgId: string,
    actorUserId: string,
    employmentId: number,
    scope: DataScope,
    type: "manager" | "department",
    opts: { page: number; limit: number },
  ) {
    await this.assertEmploymentVisible(orgId, actorUserId, employmentId, scope);
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
