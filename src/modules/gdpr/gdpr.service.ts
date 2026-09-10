import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { hrDataRequests, organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { ScopedRead } from "../access/scoped-read";
import {
  SYNC_EXPORT_CAP,
  fetchSyncAuditEntries,
  fetchSyncDataRequests,
  fetchSyncEmployment,
  fetchSyncLegalHolds,
  type SubjectExportResult,
} from "./gdpr-sync-export-fetchers";

@Injectable()
export class GdprService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async exportSubjectData(
    read: ScopedRead,
    subjectUserId: string,
  ): Promise<SubjectExportResult> {
    if (read.denied)
      throw new ForbiddenException("Export requires a resolved data scope");

    const isAll =
      read.rawScope("exporting another subject's data is an authorization gate on which subject may be read, not a row predicate") === "all";
    if (subjectUserId !== read.actorId && !isAll)
      throw new ForbiddenException(
        "Exporting another person's data requires organisation-wide scope (hr:employees:view with all scope)",
      );

    const callerOrgId = read.orgId;

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

    // This endpoint is the bounded, synchronous subset. The exhaustive extract is
    // POST /gdpr/export-async/me, which keyset-drains every source in
    // REQUIRED_GDPR_EXPORT_SOURCES with no cap; these notes name what it adds so a
    // subject is never told a source is unavailable when it is.
    const exportIncomplete: string[] = [
      `this synchronous export caps every section at ${SYNC_EXPORT_CAP} records — POST /gdpr/export-async/me returns every record`,
      "blob storage: object keys are enumerated only by the async export",
      "chat_messages, mail_message_metadata, notifications, documents, expenses and payroll sources are included only in the async export",
    ];

    const employment = await fetchSyncEmployment(
      this.db,
      subjectUserId,
      callerOrgId,
      exportIncomplete,
    );

    const dataRequests = await fetchSyncDataRequests(
      this.db,
      subjectUserId,
      callerOrgId,
      exportIncomplete,
    );

    const legalHoldsRows = await fetchSyncLegalHolds(
      this.db,
      subjectUserId,
      callerOrgId,
      exportIncomplete,
    );

    const auditEntries = await fetchSyncAuditEntries(
      this.db,
      subjectUserId,
      callerOrgId,
      exportIncomplete,
    );

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
