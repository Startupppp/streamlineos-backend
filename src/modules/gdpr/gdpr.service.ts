import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";

const SYNC_EXPORT_CAP = 500;
import { and, eq, isNull } from "drizzle-orm";
import {
  auditLogs,
  hrDataRequests,
  hrEmployments,
  hrLegalHolds,
  hrPeople,
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { DataScope } from "../access/access.types";

export interface SubjectExportResult {
  exportedAt: string;
  subject: {
    userId: string;
    email: string;
    name: string | null;
  };
  memberships: Array<{
    orgId: string;
    role: string;
    status: string;
    joinedAt: Date | null;
  }>;
  employment: Array<{
    orgId: string;
    lifecycleStatus: string;
    departmentId: string | null;
    designation: string | null;
    joiningDate: string | null;
    lastWorkingDay: string | null;
  }>;
  dataRequests: Array<{
    id: number;
    orgId: string;
    type: string;
    status: string;
    reason: string | null;
    createdAt: Date;
  }>;
  legalHolds: Array<{
    id: number;
    orgId: string;
    reason: string;
    status: string;
    placedAt: Date;
    releasedAt: Date | null;
  }>;
  auditEntries: Array<{
    id: number;
    action: string;
    targetId: string | null;
    targetType: string | null;
    actorUserId: string | null;
    resourceType: string | null;
    resourceId: string | null;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
  }>;
  auditEntriesPresent: boolean;
  exportIncomplete: string[];
}

@Injectable()
export class GdprService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async exportSubjectData(
    subjectUserId: string,
    callerUserId: string,
    callerOrgId: string,
    callerScope: DataScope,
  ): Promise<SubjectExportResult> {
    if (callerScope === "none")
      throw new ForbiddenException("Export requires a resolved data scope");

    if (subjectUserId !== callerUserId && callerScope !== "all")
      throw new ForbiddenException(
        "Exporting another person's data requires organisation-wide scope (hr:employees:view with all scope)",
      );

    const memberships = await this.db
      .select({
        orgId: organizationMembers.orgId,
        role: organizationMembers.role,
        status: organizationMembers.status,
        joinedAt: organizationMembers.joinedAt,
      })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, subjectUserId),
          eq(organizationMembers.orgId, callerOrgId),
        ),
      );

    if (memberships.length === 0) throw new NotFoundException("Subject not found");

    const [subject] = await this.db
      .select({ userId: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, subjectUserId))
      .limit(1);

    if (!subject) throw new NotFoundException("Subject not found");

    const exportIncomplete: string[] = [
      "audit_logs: existence confirmed only — full extract requires elevated tooling",
      "blob storage: R2 object keys require R2_ENDPOINT + credentials (see purge-user.mjs)",
      "chat_messages, mail_messages: not included — contact support under regulatory order",
    ];

    const hrPersonRowsRaw = await this.db
      .select({
        orgId: hrPeople.orgId,
        hrPersonId: hrPeople.id,
      })
      .from(hrPeople)
      .where(
        and(
          eq(hrPeople.userId, subjectUserId),
          eq(hrPeople.orgId, callerOrgId),
          isNull(hrPeople.deletedAt),
        ),
      )
      .limit(SYNC_EXPORT_CAP + 1);
    if (hrPersonRowsRaw.length > SYNC_EXPORT_CAP)
      exportIncomplete.push(`hr_people: truncated at ${SYNC_EXPORT_CAP} records — use async export for full extract`);
    const hrPersonRows = hrPersonRowsRaw.slice(0, SYNC_EXPORT_CAP);

    const employment: SubjectExportResult["employment"] = [];
    for (const person of hrPersonRows) {
      const rows = await this.db
        .select({
          orgId: hrPeople.orgId,
          lifecycleStatus: hrEmployments.lifecycleStatus,
          departmentId: hrEmployments.departmentId,
          designation: hrEmployments.designation,
          joiningDate: hrEmployments.joiningDate,
          lastWorkingDay: hrEmployments.lastWorkingDay,
        })
        .from(hrEmployments)
        .innerJoin(hrPeople, eq(hrEmployments.personId, hrPeople.id))
        .where(
          and(
            eq(hrEmployments.personId, person.hrPersonId),
            eq(hrPeople.orgId, callerOrgId),
            isNull(hrEmployments.deletedAt),
          ),
        )
        .limit(SYNC_EXPORT_CAP + 1);
      if (rows.length > SYNC_EXPORT_CAP)
        exportIncomplete.push(`hr_employments: truncated at ${SYNC_EXPORT_CAP} records for person ${person.hrPersonId} — use async export for full extract`);
      for (const r of rows.slice(0, SYNC_EXPORT_CAP))
        employment.push({
          orgId: r.orgId,
          lifecycleStatus: r.lifecycleStatus,
          departmentId: r.departmentId ?? null,
          designation: r.designation ?? null,
          joiningDate: r.joiningDate ?? null,
          lastWorkingDay: r.lastWorkingDay ?? null,
        });
    }

    const dataRequestsRaw = await this.db
      .select({
        id: hrDataRequests.id,
        orgId: hrDataRequests.orgId,
        type: hrDataRequests.type,
        status: hrDataRequests.status,
        reason: hrDataRequests.reason,
        createdAt: hrDataRequests.createdAt,
      })
      .from(hrDataRequests)
      .where(
        and(
          eq(hrDataRequests.subjectUserId, subjectUserId),
          eq(hrDataRequests.orgId, callerOrgId),
          isNull(hrDataRequests.deletedAt),
        ),
      )
      .limit(SYNC_EXPORT_CAP + 1);
    if (dataRequestsRaw.length > SYNC_EXPORT_CAP)
      exportIncomplete.push(`hr_data_requests: truncated at ${SYNC_EXPORT_CAP} records — use async export for full extract`);
    const dataRequests = dataRequestsRaw.slice(0, SYNC_EXPORT_CAP);

    const legalHoldsRaw = await this.db
      .select({
        id: hrLegalHolds.id,
        orgId: hrLegalHolds.orgId,
        reason: hrLegalHolds.reason,
        status: hrLegalHolds.status,
        placedAt: hrLegalHolds.placedAt,
        releasedAt: hrLegalHolds.releasedAt,
      })
      .from(hrLegalHolds)
      .where(
        and(
          eq(hrLegalHolds.subjectUserId, subjectUserId),
          eq(hrLegalHolds.orgId, callerOrgId),
          isNull(hrLegalHolds.deletedAt),
        ),
      )
      .limit(SYNC_EXPORT_CAP + 1);
    if (legalHoldsRaw.length > SYNC_EXPORT_CAP)
      exportIncomplete.push(`hr_legal_holds: truncated at ${SYNC_EXPORT_CAP} records — use async export for full extract`);
    const legalHoldsRows = legalHoldsRaw.slice(0, SYNC_EXPORT_CAP);

    const auditEntriesRaw = await this.db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        targetId: auditLogs.targetId,
        targetType: auditLogs.targetType,
        actorUserId: auditLogs.actorUserId,
        resourceType: auditLogs.resourceType,
        resourceId: auditLogs.resourceId,
        metadata: auditLogs.metadata,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(and(eq(auditLogs.userId, subjectUserId), eq(auditLogs.orgId, callerOrgId)))
      .limit(SYNC_EXPORT_CAP + 1);
    if (auditEntriesRaw.length > SYNC_EXPORT_CAP)
      exportIncomplete.push(`audit_logs: truncated at ${SYNC_EXPORT_CAP} records — use async export for full extract`);
    const auditEntries = auditEntriesRaw.slice(0, SYNC_EXPORT_CAP);

    return {
      exportedAt: new Date().toISOString(),
      subject: { userId: subject.userId, email: subject.email, name: subject.name ?? null },
      memberships: memberships.map((m) => ({
        orgId: m.orgId,
        role: m.role,
        status: m.status,
        joinedAt: m.joinedAt,
      })),
      employment,
      dataRequests: dataRequests.map((d) => ({
        id: d.id,
        orgId: d.orgId,
        type: d.type,
        status: d.status,
        reason: d.reason ?? null,
        createdAt: d.createdAt,
      })),
      legalHolds: legalHoldsRows.map((h) => ({
        id: h.id,
        orgId: h.orgId,
        reason: h.reason,
        status: h.status,
        placedAt: h.placedAt,
        releasedAt: h.releasedAt ?? null,
      })),
      auditEntries: auditEntries.map((entry) => ({
        ...entry,
        targetId: entry.targetId ?? null,
        targetType: entry.targetType ?? null,
        actorUserId: entry.actorUserId ?? null,
        resourceType: entry.resourceType ?? null,
        resourceId: entry.resourceId ?? null,
        metadata: entry.metadata ?? null,
      })),
      auditEntriesPresent: auditEntries.length > 0,
      exportIncomplete,
    };
  }

  async recordExportRequest(
    orgId: string,
    subjectUserId: string,
    requestedBy: string,
    reason: string | undefined,
    exportIncomplete: string[],
  ): Promise<number> {
    const status = exportIncomplete.length > 0 ? "partial" : "completed";
    const [row] = await this.db
      .insert(hrDataRequests)
      .values({
        orgId,
        subjectUserId,
        type: "export",
        status,
        requestedBy,
        reason: reason ?? null,
        completedAt: new Date(),
      })
      .returning({ id: hrDataRequests.id });
    if (!row) throw new NotFoundException("Export request could not be recorded");
    return row.id;
  }
}
