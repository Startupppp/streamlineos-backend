import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import { drainPages } from "./drain";
import { StorageService } from "../storage/storage.service";
import { storagePendingPurge } from "../../db/schema/common/storage-pending-purge";
import type { TenantTx } from "../../common/tenant";
import {
  hrRetentionPolicies,
  hrAuditLogs,
  hrPeople,
  hrCases,
  attendance,
} from "../../db/schema";
import { sweepRetentionDocuments } from "./cron-hr-retention-documents";

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

export type PurgeOutcome = "deleted" | "pending_retry" | "lost";

/**
 * Deletes one object whose owning row retention has already removed, recording a
 * pending-purge ledger row BEFORE the delete is attempted.
 *
 * The order is the whole point. The row that held this key is gone by the time
 * this runs, so before the ledger row existed a transient storage failure was
 * permanent: nothing was left pointing at the object and nothing would ever try
 * again — the sweep counted it as an orphan and moved on. With the row written
 * first, the storage sweep retries it, and a failure becomes a delay.
 *
 * Returns "deleted" on success, "pending_retry" when the delete failed but a
 * purge ledger row exists for the storage sweep to retry, or "lost" when both
 * the ledger row and the delete failed and no retry mechanism remains.
 */
export async function purgeRetiredObject(
  db: Db,
  storage: Pick<StorageService, "deleteFileIfPresent">,
  orgId: string,
  key: string,
  logError: (message: string, meta: Record<string, unknown>) => void,
): Promise<PurgeOutcome> {
  let ledgerRecorded = false;
  try {
    await db
      .insert(storagePendingPurge)
      .values({
        orgId,
        storageKey: key,
        purpose: "hr-retention:retired-object",
        bucket: "default",
        status: "pending",
      })
      .onConflictDoUpdate({
        target: [storagePendingPurge.orgId, storagePendingPurge.storageKey],
        set: { status: "pending", lastAttemptedAt: null, failedReason: null },
      });
    ledgerRecorded = true;
  } catch (err) {
    logError("[hr-retention] could not record the pending purge for a retired object", {
      orgId,
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await storage.deleteFileIfPresent(orgId, key);
  } catch (err) {
    logError(
      ledgerRecorded
        ? "[hr-retention] stored object survived its retired record — purge row left for the storage sweep to retry"
        : "[hr-retention] stored object survived its retired record — no ledger row recorded, object is orphaned",
      { orgId, key, error: err instanceof Error ? err.message : String(err) },
    );
    return ledgerRecorded ? "pending_retry" : "lost";
  }

  await db
    .update(storagePendingPurge)
    .set({ status: "confirmed", confirmedAt: new Date(), lastAttemptedAt: new Date() })
    .where(
      and(eq(storagePendingPurge.orgId, orgId), eq(storagePendingPurge.storageKey, key)),
    );
  return "deleted";
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
      const counts = await sweepRetentionDocuments(tx, {
        orgId,
        cutoff,
        action,
        batchSize: BATCH_SIZE,
        maxBatches: MAX_BATCHES,
      });
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
        const outcome = await purgeRetiredObject(this.db, this.storage, orgId, key, (message, meta) =>
          this.logger.error(message, meta),
        );
        if (outcome === "deleted") result.storageObjectsDeleted += 1;
        else result.storageObjectsOrphaned += 1;
      }
      retiredKeys.set(orgId, []);
    }
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
