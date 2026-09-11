import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTableName, type Table } from "drizzle-orm";
import {
  hrPolicies,
  interviews,
  jobPostings,
  leavePolicies,
  orgHolidays,
  recruitmentVendors,
  richDocuments,
  scheduledReports,
  shiftTemplates,
} from "../../db/schema";
import { HrPoliciesService } from "./policies/hr-policies.service";
import { AttendanceService } from "./time/attendance.service";
import { LeavePoliciesService } from "./time/leave-policies.service";
import { ShiftsService } from "./time/shifts.service";
import { HrInterviewSchedulingService } from "./interviews/hr-interview-scheduling.service";
import { HrRecruitmentReportsService } from "./interviews/hr-recruitment-reports.service";
import { RecruitmentJobsService } from "./recruitment/recruitment-jobs.service";
import { RecruitmentVendorSourcingService } from "./recruitment/recruitment-vendor-sourcing.service";
import { RichDocumentsService } from "./performance/rich-documents.service";
import type { Db } from "../../db/drizzle.module";

type Row = { id: number | string };

/**
 * The mock db records the predicate it was handed.
 *
 * Without this, every test below is a test of one thing only: "zero returned
 * rows raise NotFoundException". `where` was a bare `jest.fn()` accepting any
 * argument, so deleting `eq(table.orgId, orgId)` from any of the nine services
 * left all eighteen tests green — the attacker would then delete the OWNER's
 * row by id and the service would report success, which is the exact defect
 * this file's title claims to cover. Measured before the change: removing that
 * clause from HrPoliciesService.archive kept the suite at 18/18 passing.
 *
 * So the predicate is compiled with the real PgDialect and asserted to bind
 * the SUBJECT TABLE's own `org_id` to the CALLER's organisation. A missing
 * clause fails; a clause naming another table's org column fails; a clause
 * binding a constant rather than the caller's org fails.
 */
interface Captured {
  readonly db: Db;
  readonly where: jest.Mock;
}

function deleteDb(rows: Row[]): Captured {
  const returning = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ returning });
  const db = { delete: jest.fn().mockReturnValue({ where }) } as unknown as Db;
  return { db, where };
}

function updateDb(rows: Row[]): Captured {
  const returning = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  const db = { update: jest.fn().mockReturnValue({ set }) } as unknown as Db;
  return { db, where };
}

const dialect = new PgDialect();

function expectTenantBound(where: jest.Mock, table: Table, callerOrg: string): void {
  expect(where).toHaveBeenCalledTimes(1);
  const predicate = where.mock.calls[0]?.[0] as Parameters<PgDialect["sqlToQuery"]>[0];
  expect(predicate).toBeDefined();
  const compiled = dialect.sqlToQuery(predicate);
  const tenantClause = new RegExp(`"${getTableName(table)}"\\."org_id"\\s*=\\s*\\$(\\d+)`);
  const match = tenantClause.exec(compiled.sql);
  if (match === null)
    throw new Error(
      `predicate does not bind ${getTableName(table)}.org_id — compiled to: ${compiled.sql}`,
    );
  expect(compiled.params[Number(match[1]) - 1]).toBe(callerOrg);
}

const stub = <T,>() => ({}) as T;
const cache = { invalidate: jest.fn(), invalidateNamespace: jest.fn() };

describe("hr — a write against an id the caller's org does not own answers 404, not a silent success", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  afterEach(() => jest.clearAllMocks());

  describe("POST /hr/policies/:policyId/archive", () => {
    const make = (db: Db) =>
      new HrPoliciesService(
        db,
        cache as unknown as ConstructorParameters<typeof HrPoliciesService>[1],
        stub<ConstructorParameters<typeof HrPoliciesService>[2]>(),
        stub<ConstructorParameters<typeof HrPoliciesService>[3]>(),
      );

    it("refuses a policy the org does not own, and scopes the write to the caller's org", async () => {
      const captured = updateDb([]);
      await expect(make(captured.db).archive(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);
      expectTenantBound(captured.where, hrPolicies, ATTACKER_ORG);
    });

    it("archives the org's own policy (control)", async () => {
      const captured = updateDb([{ id: 1 }]);
      await expect(make(captured.db).archive(OWNER_ORG, 1)).resolves.toEqual({ success: true });
      expectTenantBound(captured.where, hrPolicies, OWNER_ORG);
    });
  });

  describe("DELETE /hr/attendance/holidays/:holidayId", () => {
    const make = (db: Db) =>
      new AttendanceService(
        db,
        stub<ConstructorParameters<typeof AttendanceService>[1]>(),
        stub<ConstructorParameters<typeof AttendanceService>[2]>(),
        stub<ConstructorParameters<typeof AttendanceService>[3]>(),
        stub<ConstructorParameters<typeof AttendanceService>[4]>(),
        stub<ConstructorParameters<typeof AttendanceService>[5]>(),
      );

    it("refuses a holiday the org does not own, and scopes the write to the caller's org", async () => {
      const captured = deleteDb([]);
      await expect(make(captured.db).deleteHoliday(ATTACKER_ORG, "h-1")).rejects.toThrow(
        NotFoundException,
      );
      expectTenantBound(captured.where, orgHolidays, ATTACKER_ORG);
    });

    it("deletes the org's own holiday (control)", async () => {
      const captured = deleteDb([{ id: "h-1" }]);
      await expect(make(captured.db).deleteHoliday(OWNER_ORG, "h-1")).resolves.toBeUndefined();
      expectTenantBound(captured.where, orgHolidays, OWNER_ORG);
    });
  });

  describe("DELETE /hr/leave-policies/:policyId", () => {
    it("refuses a leave policy the org does not own, and scopes the write to the caller's org", async () => {
      const captured = updateDb([]);
      await expect(new LeavePoliciesService(captured.db).remove(ATTACKER_ORG, 1)).rejects.toThrow(
        NotFoundException,
      );
      expectTenantBound(captured.where, leavePolicies, ATTACKER_ORG);
    });

    it("deactivates the org's own leave policy (control)", async () => {
      const captured = updateDb([{ id: 1 }]);
      await expect(
        new LeavePoliciesService(captured.db).remove(OWNER_ORG, 1),
      ).resolves.toBeUndefined();
      expectTenantBound(captured.where, leavePolicies, OWNER_ORG);
    });
  });

  describe("DELETE /hr/shifts/:shiftId", () => {
    it("refuses a shift the org does not own, and scopes the write to the caller's org", async () => {
      const captured = updateDb([]);
      await expect(new ShiftsService(captured.db).deleteShift(ATTACKER_ORG, 1)).rejects.toThrow(
        NotFoundException,
      );
      expectTenantBound(captured.where, shiftTemplates, ATTACKER_ORG);
    });

    it("deactivates the org's own shift (control)", async () => {
      const captured = updateDb([{ id: 1 }]);
      await expect(
        new ShiftsService(captured.db).deleteShift(OWNER_ORG, 1),
      ).resolves.toBeUndefined();
      expectTenantBound(captured.where, shiftTemplates, OWNER_ORG);
    });
  });

  describe("DELETE /hr/recruitment/interviews/:interviewId", () => {
    const make = (db: Db) =>
      new HrInterviewSchedulingService(
        db,
        cache as unknown as ConstructorParameters<typeof HrInterviewSchedulingService>[1],
        stub<ConstructorParameters<typeof HrInterviewSchedulingService>[2]>(),
        stub<ConstructorParameters<typeof HrInterviewSchedulingService>[3]>(),
        stub<ConstructorParameters<typeof HrInterviewSchedulingService>[4]>(),
      );

    it("refuses an interview the org does not own, and scopes the write to the caller's org", async () => {
      const captured = deleteDb([]);
      await expect(make(captured.db).deleteInterview(ATTACKER_ORG, 1)).rejects.toThrow(
        NotFoundException,
      );
      expectTenantBound(captured.where, interviews, ATTACKER_ORG);
    });

    it("deletes the org's own interview (control)", async () => {
      const captured = deleteDb([{ id: 1 }]);
      await expect(make(captured.db).deleteInterview(OWNER_ORG, 1)).resolves.toEqual({
        success: true,
      });
      expectTenantBound(captured.where, interviews, OWNER_ORG);
    });
  });

  describe("DELETE /hr/recruitment/reports/scheduled/:reportId", () => {
    const make = (db: Db) =>
      new HrRecruitmentReportsService(
        db,
        cache as unknown as ConstructorParameters<typeof HrRecruitmentReportsService>[1],
      );

    it("refuses a scheduled report the org does not own, and scopes the write to the caller's org", async () => {
      const captured = deleteDb([]);
      await expect(make(captured.db).deleteScheduledReport(ATTACKER_ORG, 1)).rejects.toThrow(
        NotFoundException,
      );
      expectTenantBound(captured.where, scheduledReports, ATTACKER_ORG);
    });

    it("deletes the org's own scheduled report (control)", async () => {
      const captured = deleteDb([{ id: 1 }]);
      await expect(make(captured.db).deleteScheduledReport(OWNER_ORG, 1)).resolves.toEqual({
        success: true,
      });
      expectTenantBound(captured.where, scheduledReports, OWNER_ORG);
    });
  });

  describe("DELETE /hr/recruitment/jobs/:jobId", () => {
    const make = (db: Db) =>
      new RecruitmentJobsService(
        db,
        cache as unknown as ConstructorParameters<typeof RecruitmentJobsService>[1],
        stub<ConstructorParameters<typeof RecruitmentJobsService>[2]>(),
      );

    it("refuses a job posting the org does not own, does not touch the cache, and scopes the write to the caller's org", async () => {
      const captured = deleteDb([]);
      await expect(make(captured.db).remove(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);
      expect(cache.invalidateNamespace).not.toHaveBeenCalled();
      expectTenantBound(captured.where, jobPostings, ATTACKER_ORG);
    });

    it("deletes the org's own job posting (control)", async () => {
      const captured = deleteDb([{ id: 1 }]);
      await expect(make(captured.db).remove(OWNER_ORG, 1)).resolves.toEqual({ success: true });
      expect(cache.invalidateNamespace).toHaveBeenCalledTimes(1);
      expectTenantBound(captured.where, jobPostings, OWNER_ORG);
    });
  });

  describe("DELETE /hr/recruitment/vendors/:vendorId", () => {
    it("refuses a vendor the org does not own, and scopes the write to the caller's org", async () => {
      const captured = deleteDb([]);
      await expect(
        new RecruitmentVendorSourcingService(captured.db).deleteVendor(ATTACKER_ORG, 1),
      ).rejects.toThrow(NotFoundException);
      expectTenantBound(captured.where, recruitmentVendors, ATTACKER_ORG);
    });

    it("deletes the org's own vendor (control)", async () => {
      const captured = deleteDb([{ id: 1 }]);
      await expect(
        new RecruitmentVendorSourcingService(captured.db).deleteVendor(OWNER_ORG, 1),
      ).resolves.toEqual({ success: true });
      expectTenantBound(captured.where, recruitmentVendors, OWNER_ORG);
    });
  });

  describe("DELETE /hr/rich-documents/:documentId", () => {
    it("refuses a rich document the org does not own, and scopes the write to the caller's org", async () => {
      const captured = deleteDb([]);
      await expect(new RichDocumentsService(captured.db).remove(ATTACKER_ORG, 1)).rejects.toThrow(
        NotFoundException,
      );
      expectTenantBound(captured.where, richDocuments, ATTACKER_ORG);
    });

    it("deletes the org's own rich document (control)", async () => {
      const captured = deleteDb([{ id: 1 }]);
      await expect(new RichDocumentsService(captured.db).remove(OWNER_ORG, 1)).resolves.toEqual({
        success: true,
      });
      expectTenantBound(captured.where, richDocuments, OWNER_ORG);
    });
  });
});
