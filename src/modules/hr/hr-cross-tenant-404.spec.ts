import { NotFoundException } from "@nestjs/common";
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

function deleteDb(rows: Row[]): Db {
  const returning = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ returning });
  return { delete: jest.fn().mockReturnValue({ where }) } as unknown as Db;
}

function updateDb(rows: Row[]): Db {
  const returning = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  return { update: jest.fn().mockReturnValue({ set }) } as unknown as Db;
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

    it("refuses a policy the org does not own", async () => {
      await expect(make(updateDb([])).archive(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);
    });

    it("archives the org's own policy (control)", async () => {
      await expect(make(updateDb([{ id: 1 }])).archive(OWNER_ORG, 1)).resolves.toEqual({ success: true });
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

    it("refuses a holiday the org does not own", async () => {
      await expect(make(deleteDb([])).deleteHoliday(ATTACKER_ORG, "h-1")).rejects.toThrow(NotFoundException);
    });

    it("deletes the org's own holiday (control)", async () => {
      await expect(make(deleteDb([{ id: "h-1" }])).deleteHoliday(OWNER_ORG, "h-1")).resolves.toBeUndefined();
    });
  });

  describe("DELETE /hr/leave-policies/:policyId", () => {
    it("refuses a leave policy the org does not own", async () => {
      await expect(new LeavePoliciesService(updateDb([])).remove(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);
    });

    it("deactivates the org's own leave policy (control)", async () => {
      await expect(new LeavePoliciesService(updateDb([{ id: 1 }])).remove(OWNER_ORG, 1)).resolves.toBeUndefined();
    });
  });

  describe("DELETE /hr/shifts/:shiftId", () => {
    it("refuses a shift the org does not own", async () => {
      await expect(new ShiftsService(updateDb([])).deleteShift(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);
    });

    it("deactivates the org's own shift (control)", async () => {
      await expect(new ShiftsService(updateDb([{ id: 1 }])).deleteShift(OWNER_ORG, 1)).resolves.toBeUndefined();
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

    it("refuses an interview the org does not own", async () => {
      await expect(make(deleteDb([])).deleteInterview(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);
    });

    it("deletes the org's own interview (control)", async () => {
      await expect(make(deleteDb([{ id: 1 }])).deleteInterview(OWNER_ORG, 1)).resolves.toEqual({ success: true });
    });
  });

  describe("DELETE /hr/recruitment/reports/scheduled/:reportId", () => {
    const make = (db: Db) =>
      new HrRecruitmentReportsService(
        db,
        cache as unknown as ConstructorParameters<typeof HrRecruitmentReportsService>[1],
      );

    it("refuses a scheduled report the org does not own", async () => {
      await expect(make(deleteDb([])).deleteScheduledReport(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);
    });

    it("deletes the org's own scheduled report (control)", async () => {
      await expect(make(deleteDb([{ id: 1 }])).deleteScheduledReport(OWNER_ORG, 1)).resolves.toEqual({
        success: true,
      });
    });
  });

  describe("DELETE /hr/recruitment/jobs/:jobId", () => {
    const make = (db: Db) =>
      new RecruitmentJobsService(
        db,
        cache as unknown as ConstructorParameters<typeof RecruitmentJobsService>[1],
        stub<ConstructorParameters<typeof RecruitmentJobsService>[2]>(),
      );

    it("refuses a job posting the org does not own, and does not touch the cache", async () => {
      await expect(make(deleteDb([])).remove(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);
      expect(cache.invalidateNamespace).not.toHaveBeenCalled();
    });

    it("deletes the org's own job posting (control)", async () => {
      await expect(make(deleteDb([{ id: 1 }])).remove(OWNER_ORG, 1)).resolves.toEqual({ success: true });
      expect(cache.invalidateNamespace).toHaveBeenCalledTimes(1);
    });
  });

  describe("DELETE /hr/recruitment/vendors/:vendorId", () => {
    it("refuses a vendor the org does not own", async () => {
      await expect(new RecruitmentVendorSourcingService(deleteDb([])).deleteVendor(ATTACKER_ORG, 1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("deletes the org's own vendor (control)", async () => {
      await expect(
        new RecruitmentVendorSourcingService(deleteDb([{ id: 1 }])).deleteVendor(OWNER_ORG, 1),
      ).resolves.toEqual({ success: true });
    });
  });

  describe("DELETE /hr/rich-documents/:documentId", () => {
    it("refuses a rich document the org does not own", async () => {
      await expect(new RichDocumentsService(deleteDb([])).remove(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);
    });

    it("deletes the org's own rich document (control)", async () => {
      await expect(new RichDocumentsService(deleteDb([{ id: 1 }])).remove(OWNER_ORG, 1)).resolves.toEqual({
        success: true,
      });
    });
  });
});
