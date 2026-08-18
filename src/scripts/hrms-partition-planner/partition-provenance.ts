import { z } from "zod";
import {
  buildOperationId,
  rootMigration,
} from "../hrms-schema-bundle/bundle-config";

export const partitionHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const opaqueApprovalIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

const logicalBundleIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/);
const operationIdSchema = z
  .string()
  .min(3)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/);
export const partitionRoleSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z_][A-Za-z0-9_$-]*$/);

function dependencySchema<const FileName extends string>(fileName: FileName) {
  return z
    .object({
      operationId: operationIdSchema,
      logicalBundleId: logicalBundleIdSchema,
      rootMigrationName: z.string().refine((value) => value === rootMigration.name),
      rootMigrationSha256: partitionHashSchema,
      fileName: z.literal(fileName),
      sqlSha256: partitionHashSchema,
      manifestSha256: partitionHashSchema,
      databaseRole: partitionRoleSchema,
    })
    .strict();
}

export const baseBundleDependenciesSchema = z.tuple([
  dependencySchema("0000_hrms_profiles_workforce.sql"),
  dependencySchema("0001_hrms_effective_history.sql"),
  dependencySchema("0002_hrms_leave_ledger.sql"),
  dependencySchema("0003_hrms_attendance_events.sql"),
  dependencySchema("0004_hrms_hierarchy_audit.sql"),
]);

export type BaseBundleDependency = z.infer<
  typeof baseBundleDependenciesSchema
>[number];

export function dependenciesShareIdentity(
  dependencies: readonly BaseBundleDependency[],
): boolean {
  if (dependencies.length !== 5) return false;
  const first = dependencies[0];
  if (!first) return false;
  return dependencies.every(
    (dependency) =>
      dependency.logicalBundleId === first.logicalBundleId &&
      dependency.rootMigrationName === first.rootMigrationName &&
      dependency.rootMigrationSha256 === first.rootMigrationSha256 &&
      dependency.databaseRole === first.databaseRole,
  );
}

export function dependencyOperationIdsAreExact(
  dependencies: readonly BaseBundleDependency[],
): boolean {
  return dependencies.every(
    (dependency) =>
      dependency.operationId ===
      buildOperationId(
        dependency.logicalBundleId,
        dependency.fileName,
        dependency.manifestSha256,
      ),
  );
}
