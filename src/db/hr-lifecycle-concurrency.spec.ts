import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bundleRoot = "migrations/pending/hrms-lifecycle-concurrency";

function readBundleFile(fileName: string): string {
  return readFileSync(resolve(process.cwd(), bundleRoot, fileName), "utf8").replace(/\r\n/g, "\n");
}

function readSchemaFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");
}

describe("HRMS lifecycle concurrency review bundle", () => {
  const backfill = readBundleFile("0000_hrms_lifecycle_concurrency.backfill.sql");
  const forward = readBundleFile("0001_hrms_lifecycle_concurrency.sql");
  const rollback = readBundleFile("0001_hrms_lifecycle_concurrency.down.sql");
  const verification = readBundleFile("0002_hrms_lifecycle_concurrency.verify.sql");
  const attendanceSchema = readSchemaFile("src/db/schema/hr/attendance.ts");
  const lifecycleSchema = readSchemaFile("src/db/schema/hr/offboarding.ts");
  const leaveSchema = readSchemaFile("src/db/schema/hr/leaves.ts");

  it("backfills positive lifecycle versions before enforcing not-null", () => {
    expect(backfill).toContain("UPDATE public.resignations");
    expect(backfill).toContain("UPDATE public.terminations");
    expect(backfill.match(/SET row_version = 1/g)).toHaveLength(2);
    expect(forward.match(/ALTER COLUMN row_version SET NOT NULL/g)).toHaveLength(2);
  });

  it("rejects unknown legacy values instead of silently remapping them", () => {
    for (const errorCode of [
      "HRMS_ATTENDANCE_STATUS_REQUIRES_REVIEW",
      "HRMS_ONBOARDING_OWNER_ROLE_REQUIRES_REVIEW",
      "HRMS_ONBOARDING_TASK_STATUS_REQUIRES_REVIEW",
      "HRMS_ONBOARDING_DOCUMENT_VERSION_DUPLICATE",
      "HRMS_LEAVE_REQUEST_TYPE_REQUIRES_REVIEW",
      "HRMS_LEAVE_BLACKOUT_SCOPE_REQUIRES_REVIEW",
    ]) {
      expect(forward).toContain(errorCode);
    }
    expect(forward).not.toMatch(/UPDATE public\.(attendance|onboarding_tasks)/);
  });

  it("enforces tenant document versions with a concurrent unique index", () => {
    expect(forward).toContain(
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_onboarding_documents_org_user_type_version",
    );
    expect(forward).toContain(
      "ON public.onboarding_documents (org_id, user_id, document_type_id, version)",
    );
    expect(verification).toContain("HRMS_ONBOARDING_DOCUMENT_VERSION_INDEX_MISSING");
  });

  it("uses validated checks and refuses rollback after versions advance", () => {
    expect(forward.match(/VALIDATE CONSTRAINT/g)).toHaveLength(12);
    expect(verification).toContain("constraint_catalog.convalidated");
    expect(rollback).toContain("HRMS_LIFECYCLE_ROLLBACK_REFUSED_ROW_VERSION_IN_USE");
  });

  it("keeps the Drizzle schema aligned with every deployed contract", () => {
    expect(attendanceSchema).toContain('check(\n    "chk_attendance_status"');
    for (const contractName of [
      "chk_onboarding_template_steps_owner_role",
      "chk_onboarding_tasks_owner_role",
      "chk_onboarding_tasks_status",
      "uniq_onboarding_documents_org_user_type_version",
      "chk_onboarding_documents_version_positive",
      "chk_resignations_row_version",
      "chk_terminations_row_version",
    ]) {
      expect(lifecycleSchema).toContain(contractName);
    }
    for (const contractName of [
      "chk_leave_requests_priority",
      "chk_leave_requests_half_day_period",
      "chk_leave_blackout_dates_applies_to",
    ]) {
      expect(leaveSchema).toContain(contractName);
    }
  });
});
