import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import { drainPages } from "./drain";
import { StorageService } from "../storage/storage.service";
import type { TenantTx } from "../../common/tenant";
import {
  hrRetentionPolicies,
  hrAuditLogs,
  hrPeople,
  hrCases,
  attendance,
  documents,
  onboardingDocuments,
  documentAuditLogs,
} from "../../db/schema";

const BATCH_SIZE = 200;
/**
 * The drain stops here rather than holding one tenant's transaction open indefinitely.
 * Hitting it sets `truncated`, so a backlog above the cap is stated instead of silently
 * carried to the next tick — which is how a one-batch-per-tick sweep reported a clean
 * result while deleting 200 of 200,000 rows.
 */
const MAX_BATCHES = 100;

const drain = (batch: () => Promise<number>) =>
  drainPages(BATCH_SIZE, MAX_BATCHES, async () => {
    const processed = await batch();
    return { selected: processed, processed };
  });

const NON_OBJECT_FILE_REFERENCES = new Set(["retention://redacted", ""]);

function collectRetiredKeys(
  into: string[],
  candidates: ReadonlyArray<{ id: number; fileUrl: string | null }>,
  affectedIds: ReadonlyArray<number>,
): void {
  const affected = new Set(affectedIds);
  for (const candidate of candidates) {
    if (!affected.has(candidate.id)) continue;
    const reference = candidate.fileUrl;
    if (!reference || NON_OBJECT_FILE_REFERENCES.has(reference)) continue;
    if (/^https?:\/\//i.test(reference)) continue;
    into.push(reference);
  }
}

export interface HrRetentionSweepResult {
  organizations: number;
  organizationsFailed: number;
  /** True when any drain hit MAX_BATCHES or stalled with rows still eligible. */
  truncated: boolean;
  employeeSoftDeleted: number;
  caseSoftDeleted: number;
  attendanceDeleted: number;
  documentsDeleted: number;
  onboardingDocumentsRedacted: number;
  storageObjectsDeleted: number;
  storageObjectsOrphaned: number;
  protectedDocumentRecords: number;
  protectedPayrollPolicies: number;
  /** @deprecated Compatibility fields; policies are no longer silently skipped. */
  skippedDocumentPolicies: number;
  /** @deprecated Compatibility fields; policies are no longer silently skipped. */
  skippedPayrollPolicies: number;
}

@Injectable()
export class CronHrRetentionService {
  private readonly logger = new Logger(CronHrRetentionService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  async sweep(): Promise<HrRetentionSweepResult> {
    const result: HrRetentionSweepResult = {
      organizations: 0,
      organizationsFailed: 0,
      truncated: false,
      employeeSoftDeleted: 0,
      caseSoftDeleted: 0,
      attendanceDeleted: 0,
      documentsDeleted: 0,
      onboardingDocumentsRedacted: 0,
      storageObjectsDeleted: 0,
      storageObjectsOrphaned: 0,
      protectedDocumentRecords: 0,
      protectedPayrollPolicies: 0,
      skippedDocumentPolicies: 0,
      skippedPayrollPolicies: 0,
    };

    const retiredKeys = new Map<string, string[]>();

    const sweepResult = await forEachOrg(this.db, "hr-policy-retention", async (tx, orgId) => {
      const policies = await tx
        .select()
        .from(hrRetentionPolicies)
        .where(and(eq(hrRetentionPolicies.orgId, orgId), eq(hrRetentionPolicies.active, true)));

      for (const policy of policies) {
        const cutoff = new Date(Date.now() - policy.retentionMonths * 30 * 24 * 3600 * 1000);
        await this.applyPolicy(
          tx,
          orgId,
          policy.id,
          policy.recordType,
          policy.action,
          cutoff,
          result,
          retiredKeys,
        );
      }
    });

    await this.deleteRetiredObjects(retiredKeys, result);

    result.organizations = sweepResult.organizations;
    result.organizationsFailed = sweepResult.failed;
    if (result.truncated)
      this.logger.warn(
        "[hr-retention] a drain hit its batch cap or stalled with rows still eligible — the next tick resumes",
      );
    this.logger.log(
      `[hr-retention] sweep complete: ${result.organizations} orgs ` +
        `(${result.organizationsFailed} failed, truncated=${result.truncated}), ` +
        `${result.employeeSoftDeleted} employees soft-deleted, ` +
        `${result.caseSoftDeleted} cases soft-deleted, ` +
        `${result.attendanceDeleted} attendance rows deleted, ` +
        `${result.documentsDeleted} documents deleted, ` +
        `${result.onboardingDocumentsRedacted} onboarding documents redacted, ` +
        `${result.storageObjectsDeleted} stored objects deleted, ` +
        `${result.storageObjectsOrphaned} stored objects left orphaned, ` +
        `${result.protectedDocumentRecords} document records protected, ` +
        `${result.protectedPayrollPolicies} payroll policies retained as immutable financial records`,
    );
    return result;
  }

  private async applyPolicy(
    tx: TenantTx,
    orgId: string,
    policyId: number,
    recordType: string,
    action: string,
    cutoff: Date,
    result: HrRetentionSweepResult,
    retiredKeys: Map<string, string[]>,
  ): Promise<void> {
    if (recordType === "employee") {
      const outcome = await drain(() => this.sweepEmployees(tx, orgId, cutoff));
      result.employeeSoftDeleted += outcome.processed;
      if (outcome.truncated) result.truncated = true;
      if (outcome.processed > 0)
        await this.auditLog(tx, orgId, "hr_person_batch", "retention_sweep.employee", action, policyId, outcome.processed, cutoff, outcome.truncated);
      return;
    }
    if (recordType === "case") {
      const outcome = await drain(() => this.sweepCases(tx, orgId, cutoff));
      result.caseSoftDeleted += outcome.processed;
      if (outcome.truncated) result.truncated = true;
      if (outcome.processed > 0)
        await this.auditLog(tx, orgId, "hr_case_batch", "retention_sweep.case", action, policyId, outcome.processed, cutoff, outcome.truncated);
      return;
    }
    if (recordType === "attendance") {
      const outcome = await drain(() => this.sweepAttendance(tx, orgId, cutoff));
      result.attendanceDeleted += outcome.processed;
      if (outcome.truncated) result.truncated = true;
      if (outcome.processed > 0)
        await this.auditLog(tx, orgId, "attendance_batch", "retention_sweep.attendance", "delete", policyId, outcome.processed, cutoff, outcome.truncated);
      return;
    }
    if (recordType === "document") {
      const counts = await this.sweepDocuments(tx, orgId, cutoff, action);
      if (counts.retiredKeys.length > 0) {
        const pending = retiredKeys.get(orgId) ?? [];
        pending.push(...counts.retiredKeys);
        retiredKeys.set(orgId, pending);
      }
      result.documentsDeleted += counts.deleted;
      result.onboardingDocumentsRedacted += counts.redacted;
      result.protectedDocumentRecords += counts.protected;
      if (counts.truncated) result.truncated = true;
      await this.auditLog(tx, orgId, "hr_document_batch", "retention_sweep.document", action, policyId, counts.deleted + counts.redacted, cutoff, counts.truncated, counts.scanned);
      return;
    }
    if (recordType === "payroll") {
      result.protectedPayrollPolicies += 1;
      await this.auditLog(tx, orgId, "hr_payroll_retention_policy", "retention_sweep.payroll_protected", action, policyId, 0, cutoff, false);
      this.logger.warn(
        "[hr-retention] payroll retention policy requires operator action — payroll_runs has FK children and no deleted_at; run manual DELETE with dependency check",
        { orgId, policyId },
      );
      return;
    }
  }

  private async sweepEmployees(tx: TenantTx, orgId: string, cutoff: Date): Promise<number> {
    const rows = await tx
      .update(hrPeople)
      .set({ deletedAt: new Date() })
      .where(
        sql`${hrPeople.id} IN (
          SELECT id FROM hr_people
          WHERE org_id = ${orgId}
            AND deleted_at IS NULL
            AND created_at < ${cutoff}
            AND (user_id IS NULL OR user_id NOT IN (
              SELECT subject_user_id FROM hr_legal_holds
              WHERE org_id = ${orgId}
                AND status = 'active'
                AND deleted_at IS NULL
                AND subject_user_id IS NOT NULL
            ))
          LIMIT ${BATCH_SIZE}
        )`,
      )
      .returning({ id: hrPeople.id });
    return rows.length;
  }

  private async sweepCases(tx: TenantTx, orgId: string, cutoff: Date): Promise<number> {
    const rows = await tx
      .update(hrCases)
      .set({ deletedAt: new Date() })
      .where(
        sql`${hrCases.id} IN (
          SELECT id FROM hr_cases
          WHERE org_id = ${orgId}
            AND deleted_at IS NULL
            AND created_at < ${cutoff}
            AND (subject_employee_id IS NULL OR subject_employee_id NOT IN (
              SELECT subject_user_id FROM hr_legal_holds
              WHERE org_id = ${orgId}
                AND status = 'active'
                AND deleted_at IS NULL
                AND subject_user_id IS NOT NULL
            ))
          LIMIT ${BATCH_SIZE}
        )`,
      )
      .returning({ id: hrCases.id });
    return rows.length;
  }

  private async sweepAttendance(tx: TenantTx, orgId: string, cutoff: Date): Promise<number> {
    const rows = await tx
      .delete(attendance)
      .where(
        sql`${attendance.id} IN (
          SELECT id FROM attendance
          WHERE org_id = ${orgId}
            AND created_at < ${cutoff}
            AND user_id NOT IN (
              SELECT subject_user_id FROM hr_legal_holds
              WHERE org_id = ${orgId}
                AND status = 'active'
                AND deleted_at IS NULL
                AND subject_user_id IS NOT NULL
            )
          LIMIT ${BATCH_SIZE}
        )`,
      )
      .returning({ id: attendance.id });
    return rows.length;
  }

  /**
   * Deletes the stored objects whose rows retention has just removed or
   * redacted. It runs after the sweep's transactions have committed, never
   * inside one: an object delete is a network call, and holding a pooled
   * connection open across it is how one storage outage stalls every tenant.
   */
  private async deleteRetiredObjects(
    retiredKeys: Map<string, string[]>,
    result: HrRetentionSweepResult,
  ): Promise<void> {
    for (const [orgId, keys] of retiredKeys) {
      for (const key of keys) {
        try {
          await this.storage.deleteFileIfPresent(orgId, key);
          result.storageObjectsDeleted += 1;
        } catch (err) {
          result.storageObjectsOrphaned += 1;
          this.logger.error(
            "[hr-retention] stored object survived its retired record — orphan left in object storage",
            { orgId, key, error: err instanceof Error ? err.message : String(err) },
          );
        }
      }
      retiredKeys.set(orgId, []);
    }
  }

  /**
   * Drains BOTH document tables rather than taking one page of each per tick.
   *
   * `scanned` is the number of rows the predicate matched, so a run that scanned 200 and
   * processed 0 is visible: that is the stall shape a policy whose `action` is neither
   * "delete" nor "anonymize" produces, and a naive loop would spin on it for ever.
   */
  private async sweepDocuments(
    tx: TenantTx,
    orgId: string,
    cutoff: Date,
    action: string,
  ): Promise<{
    deleted: number;
    redacted: number;
    protected: number;
    scanned: number;
    truncated: boolean;
    retiredKeys: string[];
  }> {
    const retiredKeys: string[] = [];
    let deleted = 0;
    let redacted = 0;
    let protectedCount = 0;
    let scanned: number;

    const generic = await drainPages(BATCH_SIZE, MAX_BATCHES, async () => {
      const rows = await this.selectGenericDocuments(tx, orgId, cutoff);
      if (rows.length === 0) return { selected: 0, processed: 0 };
      const processed = await this.processGenericDocuments(tx, orgId, action, rows, retiredKeys);
      deleted += processed.deleted;
      redacted += processed.redacted;
      return { selected: rows.length, processed: processed.deleted + processed.redacted };
    });

    const onboarding = await drainPages(BATCH_SIZE, MAX_BATCHES, async () => {
      const rows = await this.selectOnboardingDocuments(tx, orgId, cutoff);
      if (rows.length === 0) return { selected: 0, processed: 0 };
      const processed = await this.processOnboardingDocuments(tx, orgId, action, rows, retiredKeys);
      deleted += processed.deleted;
      redacted += processed.redacted;
      protectedCount += processed.protected;
      return { selected: rows.length, processed: processed.deleted + processed.redacted };
    });

    scanned = generic.scanned + onboarding.scanned;

    return {
      deleted,
      redacted,
      protected: protectedCount,
      scanned,
      truncated: generic.truncated || onboarding.truncated,
      retiredKeys,
    };
  }

  private async selectGenericDocuments(
    tx: TenantTx,
    orgId: string,
    cutoff: Date,
  ): Promise<Array<{ id: number; fileUrl: string | null }>> {
    return tx
      .select({ id: documents.id, fileUrl: documents.fileUrl })
      .from(documents)
      .where(sql`${documents.orgId} = ${orgId}
        AND ${documents.createdAt} < ${cutoff}
        AND ${documents.fileUrl} <> 'retention://redacted'
        AND NOT EXISTS (
          SELECT 1 FROM hr_legal_hold_items hli
          WHERE hli.org_id = ${orgId}
            AND hli.item_type = 'document'
            AND hli.item_ref = ${documents.id}::text
            AND hli.locked = true
        )`)
      .limit(BATCH_SIZE);
  }

  private async processGenericDocuments(
    tx: TenantTx,
    orgId: string,
    action: string,
    genericRows: Array<{ id: number; fileUrl: string | null }>,
    retiredKeys: string[],
  ): Promise<{ deleted: number; redacted: number }> {
    const ids = sql.join(
      genericRows.map((row) => sql`${row.id}`),
      sql`, `,
    );
    if (action === "delete") {
      const rows = await tx
        .delete(documents)
        .where(sql`${documents.orgId} = ${orgId} AND ${documents.id} IN (${ids})`)
        .returning({ id: documents.id });
      collectRetiredKeys(retiredKeys, genericRows, rows.map((row) => row.id));
      return { deleted: rows.length, redacted: 0 };
    }
    if (action === "anonymize") {
      const rows = await tx
        .update(documents)
        .set({ fileUrl: "retention://redacted", fileName: "redacted", description: null, metadata: null })
        .where(sql`${documents.orgId} = ${orgId} AND ${documents.id} IN (${ids})`)
        .returning({ id: documents.id });
      collectRetiredKeys(retiredKeys, genericRows, rows.map((row) => row.id));
      return { deleted: 0, redacted: rows.length };
    }
    return { deleted: 0, redacted: 0 };
  }

  private async selectOnboardingDocuments(
    tx: TenantTx,
    orgId: string,
    cutoff: Date,
  ): Promise<Array<{ id: number; fileUrl: string | null }>> {
    return tx
      .select({ id: onboardingDocuments.id, fileUrl: onboardingDocuments.fileUrl })
      .from(onboardingDocuments)
      .where(sql`${onboardingDocuments.orgId} = ${orgId}
        AND ${onboardingDocuments.createdAt} < ${cutoff}
        AND ${onboardingDocuments.fileUrl} <> 'retention://redacted'
        AND NOT EXISTS (
          SELECT 1 FROM hr_legal_hold_items hli
          WHERE hli.org_id = ${orgId}
            AND hli.item_type = 'document'
            AND hli.item_ref = ${onboardingDocuments.id}::text
            AND hli.locked = true
        )`)
      .limit(BATCH_SIZE);
  }

  private async processOnboardingDocuments(
    tx: TenantTx,
    orgId: string,
    action: string,
    onboardingRows: Array<{ id: number; fileUrl: string | null }>,
    retiredKeys: string[],
  ): Promise<{ deleted: number; redacted: number; protected: number }> {
    const auditRows = await tx
      .select({ id: documentAuditLogs.onboardingDocumentId })
      .from(documentAuditLogs)
      .where(sql`${documentAuditLogs.orgId} = ${orgId}
        AND ${documentAuditLogs.onboardingDocumentId} IN (${sql.join(onboardingRows.map((row) => sql`${row.id}`), sql`, `)})`);
    const auditedIds = new Set(auditRows.map((row) => row.id));

    let deleted = 0;
    const deletableIds = onboardingRows.map((row) => row.id).filter((id) => !auditedIds.has(id));
    if (action === "delete" && deletableIds.length > 0) {
      const rows = await tx
        .delete(onboardingDocuments)
        .where(sql`${onboardingDocuments.orgId} = ${orgId} AND ${onboardingDocuments.id} IN (${sql.join(deletableIds.map((id) => sql`${id}`), sql`, `)})`)
        .returning({ id: onboardingDocuments.id });
      deleted = rows.length;
      collectRetiredKeys(retiredKeys, onboardingRows, rows.map((row) => row.id));
    }

    let redacted = 0;
    const redactIds = onboardingRows
      .map((row) => row.id)
      .filter((id) => auditedIds.has(id) || action === "anonymize");
    if (redactIds.length > 0) {
      const rows = await tx
        .update(onboardingDocuments)
        .set({ fileUrl: "retention://redacted", fileName: "redacted", remarks: null })
        .where(sql`${onboardingDocuments.orgId} = ${orgId} AND ${onboardingDocuments.id} IN (${sql.join(redactIds.map((id) => sql`${id}`), sql`, `)})`)
        .returning({ id: onboardingDocuments.id });
      redacted = rows.length;
      collectRetiredKeys(retiredKeys, onboardingRows, rows.map((row) => row.id));
    }

    // Only this table's own rows: the count used to subtract the generic table's
    // deletions too and could go negative.
    return { deleted, redacted, protected: onboardingRows.length - deleted - redacted };
  }

  private async auditLog(
    tx: TenantTx,
    orgId: string,
    entityType: string,
    action: string,
    retentionAction: string,
    policyId: number,
    count: number,
    cutoff: Date,
    truncated: boolean,
    scanned?: number,
  ): Promise<void> {
    await tx.insert(hrAuditLogs).values({
      orgId,
      actorMembershipId: null,
      entityType,
      entityId: `policy:${policyId}`,
      action,
      after: {
        count,
        truncated,
        ...(scanned === undefined ? {} : { scanned }),
        cutoff: cutoff.toISOString(),
        retentionAction,
        policyId,
      } as Record<string, unknown>,
    });
  }
}
