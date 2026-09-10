import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull, lte, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import {
  buildCursorPage,
  decodeCursor,
} from "../../../common/pagination/cursor";
import { keysetBeforeValue } from "../../../common/pagination/keyset";
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
import type { ScopedRead } from "../../access/scoped-read";
import { primaryEmploymentOfPerson } from "../../directory/employment-query";
import {
  decodeTimelineCursor,
  encodeTimelineCursor,
  type TimelinePosition,
} from "./hr-core-list-cursors";

type TimelineEntry = {
  id: string;
  type: "status_transition" | "effective_change" | "audit";
  action: string;
  entityType: string;
  createdAt: Date;
  data: Record<string, unknown>;
};

type TimelineSource = "history" | "change" | "audit";

type TimelineCandidate = TimelineEntry & {
  source: TimelineSource;
  sourceId: number;
  sourceRank: number;
};

function afterPosition(
  createdAt: SQLWrapper,
  sourceRecordId: SQLWrapper,
  position: TimelinePosition | undefined,
) {
  if (!position) return undefined;
  const date = new Date(position.createdAt).toISOString();
  return sql<boolean>`(
    ${createdAt} < ${date}::timestamptz
    OR (${createdAt} = ${date}::timestamptz AND ${sourceRecordId} < ${position.sourceRecordId})
  )`;
}

function compareTimelineEntries(
  leftEntry: TimelineCandidate,
  rightEntry: TimelineCandidate,
) {
  const time = rightEntry.createdAt.getTime() - leftEntry.createdAt.getTime();
  if (time !== 0) return time;
  const source = leftEntry.sourceRank - rightEntry.sourceRank;
  if (source !== 0) return source;
  return rightEntry.sourceId - leftEntry.sourceId;
}

type HistoryCursorScope = {
  orgId: string;
  actorUserId: string;
  employmentId: number;
  scope: string;
  type: "manager" | "department";
};

function invalidHistoryCursor(): never {
  throw new BadRequestException({
    code: "INVALID_EMPLOYMENT_HISTORY_CURSOR",
    message: "The employment history cursor is invalid or expired.",
  });
}

function isBusinessDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function decodeHistoryCursor(
  value: string | undefined,
  expected: HistoryCursorScope,
) {
  if (!value) return null;
  const position = decodeCursor(value);
  if (!position || !isBusinessDate(position.sortValue))
    return invalidHistoryCursor();

  try {
    const scope: unknown = JSON.parse(position.id);
    if (
      !Array.isArray(scope) ||
      scope.length !== 6 ||
      typeof scope[0] !== "number" ||
      !Number.isSafeInteger(scope[0]) ||
      scope[0] < 1 ||
      scope[1] !== expected.orgId ||
      scope[2] !== expected.actorUserId ||
      scope[3] !== expected.employmentId ||
      scope[4] !== expected.scope ||
      scope[5] !== expected.type
    )
      return invalidHistoryCursor();
    return { sortValue: position.sortValue, id: String(scope[0]) };
  } catch {
    return invalidHistoryCursor();
  }
}

@Injectable()
export class HrTimelineService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async assertEmploymentVisible(
    read: ScopedRead,
    employmentId: number,
  ): Promise<void> {
    const orgId = read.orgId;
    const [visible] = await read.read(
      {
        tenant: hrEmployments.orgId,
        scope: { columns: { ownerColumn: hrPeople.userId } },
        and: [eq(hrEmployments.id, employmentId), isNull(hrEmployments.deletedAt)],
      },
      ({ sql: where }) =>
        this.db
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
          .where(where)
          .limit(1),
      () => [],
    );

    if (!visible) throw new NotFoundException("Employment not found");
  }

  async getTimeline(
    read: ScopedRead,
    employmentId: number,
    opts: { cursor?: string; limit: number },
  ) {
    const orgId = read.orgId;
    const actorUserId = read.actorId;
    const scope = read.discriminator;
    const cappedLimit = Math.min(opts.limit, 100);
    const cursor = decodeTimelineCursor(opts.cursor, {
      orgId,
      actorUserId,
      employmentId,
      scope,
    });
    await this.assertEmploymentVisible(read, employmentId);
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
          createdByMembershipId: hrEmploymentHistory.createdByMembershipId,
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
          actorMembershipId: hrAuditLogs.actorMembershipId,
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
          createdByMembershipId: historyEntry.createdByMembershipId,
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
          actorMembershipId: auditEntry.actorMembershipId,
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

  async getEmploymentByUserId(read: ScopedRead, userId: string) {
    const orgId = read.orgId;
    const [row] = await read.read(
      {
        tenant: hrPeople.orgId,
        scope: { columns: { ownerColumn: organizationMembers.userId } },
        and: [eq(hrPeople.userId, userId), isNull(hrPeople.deletedAt)],
      },
      ({ sql: where }) =>
        this.db
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
              eq(
                organizationPeople.organizationPersonId,
                hrPeople.organizationPersonId,
              ),
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
          .where(where)
          .limit(1),
      () => [],
    );

    if (!row) throw new NotFoundException("Employee not found");

    return row;
  }

  async getHistory(
    read: ScopedRead,
    employmentId: number,
    type: "manager" | "department",
    opts: { cursor?: string; limit: number },
  ) {
    const orgId = read.orgId;
    const actorUserId = read.actorId;
    const scope = read.discriminator;
    const cursorScope = { orgId, actorUserId, employmentId, scope, type };
    const cursor = decodeHistoryCursor(opts.cursor, cursorScope);
    await this.assertEmploymentVisible(read, employmentId);
    const limit = Math.min(opts.limit, 100);
    const changeType = type === "manager" ? "manager" : "department";
    const conditions = [
      eq(hrEffectiveDatedChanges.orgId, orgId),
      eq(hrEffectiveDatedChanges.employmentId, employmentId),
      eq(hrEffectiveDatedChanges.changeType, changeType),
    ];
    if (cursor)
      conditions.push(
        keysetBeforeValue(
          hrEffectiveDatedChanges.effectiveFrom,
          hrEffectiveDatedChanges.id,
          cursor,
        ),
      );

    const rows = await this.db
      .select()
      .from(hrEffectiveDatedChanges)
      .where(and(...conditions))
      .orderBy(
        desc(hrEffectiveDatedChanges.effectiveFrom),
        desc(hrEffectiveDatedChanges.id),
      )
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: String(row.effectiveFrom),
      id: JSON.stringify([
        row.id,
        cursorScope.orgId,
        cursorScope.actorUserId,
        cursorScope.employmentId,
        cursorScope.scope,
        cursorScope.type,
      ]),
    }));
  }
}
