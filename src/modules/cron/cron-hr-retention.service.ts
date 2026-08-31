import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";
import {
  hrRetentionPolicies,
  hrAuditLogs,
  hrPeople,
  hrCases,
  attendance,
} from "../../db/schema";

const BATCH_SIZE = 200;

export interface HrRetentionSweepResult {
  organizations: number;
  employeeSoftDeleted: number;
  caseSoftDeleted: number;
  attendanceDeleted: number;
  skippedDocumentPolicies: number;
  skippedPayrollPolicies: number;
}

@Injectable()
export class CronHrRetentionService {
  private readonly logger = new Logger(CronHrRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async sweep(): Promise<HrRetentionSweepResult> {
    const result: HrRetentionSweepResult = {
      organizations: 0,
      employeeSoftDeleted: 0,
      caseSoftDeleted: 0,
      attendanceDeleted: 0,
      skippedDocumentPolicies: 0,
      skippedPayrollPolicies: 0,
    };

    const sweepResult = await forEachOrg(this.db, "hr-policy-retention", async (tx, orgId) => {
      const policies = await tx
        .select()
        .from(hrRetentionPolicies)
        .where(and(eq(hrRetentionPolicies.orgId, orgId), eq(hrRetentionPolicies.active, true)));

      for (const policy of policies) {
        const cutoff = new Date(Date.now() - policy.retentionMonths * 30 * 24 * 3600 * 1000);
        await this.applyPolicy(tx, orgId, policy.id, policy.recordType, policy.action, cutoff, result);
      }
    });

    result.organizations = sweepResult.organizations;
    this.logger.log(
      `[hr-retention] sweep complete: ${result.organizations} orgs, ` +
        `${result.employeeSoftDeleted} employees soft-deleted, ` +
        `${result.caseSoftDeleted} cases soft-deleted, ` +
        `${result.attendanceDeleted} attendance rows deleted, ` +
        `${result.skippedDocumentPolicies} document policies skipped, ` +
        `${result.skippedPayrollPolicies} payroll policies require operator action`,
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
  ): Promise<void> {
    if (recordType === "employee") {
      const count = await this.sweepEmployees(tx, orgId, cutoff);
      result.employeeSoftDeleted += count;
      if (count > 0)
        await this.auditLog(tx, orgId, "hr_person_batch", "retention_sweep.employee", action, policyId, count, cutoff);
      return;
    }
    if (recordType === "case") {
      const count = await this.sweepCases(tx, orgId, cutoff);
      result.caseSoftDeleted += count;
      if (count > 0)
        await this.auditLog(tx, orgId, "hr_case_batch", "retention_sweep.case", action, policyId, count, cutoff);
      return;
    }
    if (recordType === "attendance") {
      const count = await this.sweepAttendance(tx, orgId, cutoff);
      result.attendanceDeleted += count;
      if (count > 0)
        await this.auditLog(tx, orgId, "attendance_batch", "retention_sweep.attendance", "delete", policyId, count, cutoff);
      return;
    }
    if (recordType === "document") {
      result.skippedDocumentPolicies += 1;
      this.logger.warn("[hr-retention] document retention policy skipped — no standalone hr_documents table", {
        orgId,
        policyId,
      });
      return;
    }
    if (recordType === "payroll") {
      result.skippedPayrollPolicies += 1;
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

  private async auditLog(
    tx: TenantTx,
    orgId: string,
    entityType: string,
    action: string,
    retentionAction: string,
    policyId: number,
    count: number,
    cutoff: Date,
  ): Promise<void> {
    await tx.insert(hrAuditLogs).values({
      orgId,
      actorMembershipId: null,
      entityType,
      entityId: `policy:${policyId}`,
      action,
      after: { count, cutoff: cutoff.toISOString(), retentionAction, policyId } as Record<string, unknown>,
    });
  }
}
