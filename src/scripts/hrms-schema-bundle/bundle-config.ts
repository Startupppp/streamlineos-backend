import { z } from "zod";

export const bundleEnvironmentSchema = z.enum([
  "development",
  "test",
  "staging",
  "production",
]);

export const bundleFileNameSchema = z.enum([
  "0000_hrms_profiles_workforce.sql",
  "0001_hrms_effective_history.sql",
  "0002_hrms_leave_ledger.sql",
  "0003_hrms_attendance_events.sql",
  "0004_hrms_hierarchy_audit.sql",
]);

export const bundleDownFileNameSchema = z.enum([
  "0000_hrms_profiles_workforce.down.sql",
  "0001_hrms_effective_history.down.sql",
  "0002_hrms_leave_ledger.down.sql",
  "0003_hrms_attendance_events.down.sql",
  "0004_hrms_hierarchy_audit.down.sql",
]);

export type BundleEnvironment = z.infer<typeof bundleEnvironmentSchema>;
export type BundleFileName = z.infer<typeof bundleFileNameSchema>;
export type BundleDownFileName = z.infer<typeof bundleDownFileNameSchema>;

export const bundleFileNames: BundleFileName[] = [
  "0000_hrms_profiles_workforce.sql",
  "0001_hrms_effective_history.sql",
  "0002_hrms_leave_ledger.sql",
  "0003_hrms_attendance_events.sql",
  "0004_hrms_hierarchy_audit.sql",
];

export const bundleDownFileNames: BundleDownFileName[] = [
  "0000_hrms_profiles_workforce.down.sql",
  "0001_hrms_effective_history.down.sql",
  "0002_hrms_leave_ledger.down.sql",
  "0003_hrms_attendance_events.down.sql",
  "0004_hrms_hierarchy_audit.down.sql",
];

export function downFileName(fileName: BundleFileName): BundleDownFileName {
  if (fileName === "0000_hrms_profiles_workforce.sql")
    return "0000_hrms_profiles_workforce.down.sql";
  if (fileName === "0001_hrms_effective_history.sql")
    return "0001_hrms_effective_history.down.sql";
  if (fileName === "0002_hrms_leave_ledger.sql")
    return "0002_hrms_leave_ledger.down.sql";
  if (fileName === "0003_hrms_attendance_events.sql")
    return "0003_hrms_attendance_events.down.sql";
  return "0004_hrms_hierarchy_audit.down.sql";
}

export const rootMigration = {
  name: "0398_backfill_hr_admin_branch_hr_recruitment_grants.sql",
  createdAt: 1785775600000,
};

export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export function buildLogicalBundleId(
  bundleId: string,
  bundleVersion: string,
): string {
  return `${bundleId}@${bundleVersion}`;
}

export function buildOperationId(
  logicalBundleId: string,
  fileName: BundleFileName,
  manifestSha256: string,
): string {
  return `${logicalBundleId}:${fileName}:${manifestSha256}`;
}
