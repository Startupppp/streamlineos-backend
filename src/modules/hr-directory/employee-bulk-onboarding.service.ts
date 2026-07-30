import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { orgUnits } from "../../db/schema";
import { nextDepartmentCode, toDepartmentCode } from "../org-hierarchy/lib/department-code";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { EmployeeOnboardingService } from "./employee-onboarding.service";
import type { BulkOnboardEmployeeRow, OnboardEmployeeInput } from "./dto/hr-directory.schemas";
import { ORG_MEMBER_ROLES } from "../../common/rbac/org-roles";

@Injectable()
export class EmployeeBulkOnboardingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly onboarding: EmployeeOnboardingService,
  ) {}

  async onboardEmployeesBulk(actor: CurrentUserContext, rows: BulkOnboardEmployeeRow[]) {
    const orgDeptRows = await this.db
      .select({
        id: orgUnits.id,
        name: orgUnits.name,
        code: orgUnits.code,
      })
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.orgId, actor.orgId),
          eq(orgUnits.kind, "DEPARTMENT"),
          isNull(orgUnits.deletedAt),
          sql`${orgUnits.status} <> 'ARCHIVED'`,
        ),
      );

    const orgDeptByKey = new Map<string, string>();
    const usedCodes = new Set<string>();
    for (const d of orgDeptRows) {
      orgDeptByKey.set(d.name.trim().toLowerCase(), d.id);
      if (d.code?.trim()) orgDeptByKey.set(d.code.trim().toLowerCase(), d.id);
      if (d.code?.trim()) usedCodes.add(d.code);
    }

    const resolveDepartmentId = async (raw: string): Promise<string | undefined> => {
      const key = raw.trim().toLowerCase();
      if (!key) return undefined;

      const existing = orgDeptByKey.get(key);
      if (existing) return existing;

      const name = raw.trim();
      const base = toDepartmentCode(name);
      let code = base;
      let suffix = 2;
      while (usedCodes.has(code)) {
        code = nextDepartmentCode(base, suffix);
        suffix += 1;
      }

      const inserted = await this.db
        .insert(orgUnits)
        .values({ orgId: actor.orgId, kind: "DEPARTMENT", name, code, status: "ACTIVE" })
        .onConflictDoNothing({ target: [orgUnits.orgId, orgUnits.kind, orgUnits.code] })
        .returning({ id: orgUnits.id, name: orgUnits.name });

      let row = inserted[0];
      if (!row) {
        const [found] = await this.db
          .select({ id: orgUnits.id, name: orgUnits.name })
          .from(orgUnits)
          .where(
            and(
              eq(orgUnits.orgId, actor.orgId),
              eq(orgUnits.kind, "DEPARTMENT"),
              isNull(orgUnits.deletedAt),
              sql`lower(${orgUnits.name}) = ${key}`,
            ),
          )
          .limit(1);
        row = found;
      }
      if (!row) return undefined;

      usedCodes.add(code);
      orgDeptByKey.set(row.name.trim().toLowerCase(), row.id);
      return row.id;
    };

    const seenEmails = new Set<string>();
    const results: Array<{
      row: number;
      email: string;
      success: boolean;
      userId?: string;
      error?: string;
    }> = [];

    let created = 0;
    let failed = 0;

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const rowNum = i + 1;
      const email = row.email.trim().toLowerCase();

      if (seenEmails.has(email)) {
        failed += 1;
        results.push({
          row: rowNum,
          email,
          success: false,
          error: "Duplicate email in this upload",
        });
        continue;
      }
      seenEmails.add(email);

      let departmentId = row.departmentId;
      if (departmentId == null && row.department) {
        departmentId = await resolveDepartmentId(row.department);
        if (departmentId == null) {
          failed += 1;
          results.push({
            row: rowNum,
            email,
            success: false,
            error: `Unknown department "${row.department}". Create it under Organization → Departments (or HR departments) first.`,
          });
          continue;
        }
      }

      const payload: OnboardEmployeeInput = {
        firstName: row.firstName.trim(),
        lastName: row.lastName.trim(),
        email,
        phone: row.phone,
        whatsappSameAsPhone: row.whatsappSameAsPhone ?? true,
        whatsappNumber: row.whatsappNumber,
        gender: row.gender,
        designation: row.designation.trim(),
        departmentId,
        role: row.role || ORG_MEMBER_ROLES.MEMBER,
        employeeId: row.employeeId,
        joiningDate: row.joiningDate,
        dateOfBirth: row.dateOfBirth,
        taxId: row.taxId,
        monthlySalary: row.monthlySalary,
        bankDetails: row.bankDetails,
      };

      try {
        const res = await this.onboarding.onboardEmployee(actor, payload);
        created += 1;
        results.push({
          row: rowNum,
          email,
          success: true,
          userId: res.userId,
        });
      } catch (err) {
        failed += 1;
        const message =
          err instanceof Error ? err.message : "Failed to onboard employee";
        results.push({ row: rowNum, email, success: false, error: message });
      }
    }

    this.audit.log({
      action: "hr.employees_bulk_onboarded",
      userId: actor.userId,
      orgId: actor.orgId,
      targetType: "employee",
      metadata: { total: rows.length, created, failed },
    });

    return {
      total: rows.length,
      created,
      failed,
      results,
    };
  }
}
