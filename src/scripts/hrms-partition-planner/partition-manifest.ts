import { createHash } from "node:crypto";
import { z } from "zod";
import {
  approvedHashModulus,
  environmentSchema,
  hashPartitionTables,
  monthSchema,
  partitionSecurityProfileSchema,
  rangePartitionTables,
  partitionTableSchema,
  tenantIdSchema,
  type PartitionSecurityProfile,
  type PartitionTable,
} from "./partition-config";
import { failPartition } from "./partition-error";
import type { PlannerOptions } from "./partition-options";
import {
  baseBundleDependenciesSchema,
  dependencyOperationIdsAreExact,
  dependenciesShareIdentity,
  opaqueApprovalIdSchema,
  partitionRoleSchema,
} from "./partition-provenance";

const uniqueValues = (values: string[]): boolean =>
  new Set(values).size === values.length;

const hashTableSet = new Set<string>(hashPartitionTables);
const rangeTableSet = new Set<string>(rangePartitionTables);
const securityProfileSchema = z
  .object({
    table: partitionTableSchema,
    profile: partitionSecurityProfileSchema,
  })
  .strict();
const databaseNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/);

export const partitionManifestSchema = z
  .object({
    version: z.literal(1),
    approvalId: opaqueApprovalIdSchema,
    environment: environmentSchema,
    database: databaseNameSchema,
    databaseRole: partitionRoleSchema,
    applicationRole: partitionRoleSchema,
    migrationRole: partitionRoleSchema,
    tables: z.array(partitionTableSchema).min(1).refine(uniqueValues),
    securityProfiles: z.array(securityProfileSchema).min(1),
    months: z.array(monthSchema).refine(uniqueValues),
    tenantIds: z.array(tenantIdSchema).max(1000).refine(uniqueValues),
    hashModulus: z.literal(approvedHashModulus).nullable(),
    expiresAt: z.string().datetime({ offset: true }),
    baseBundleDependencies: baseBundleDependenciesSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const hasHashTables = manifest.tables.some((table) => hashTableSet.has(table));
    const hasRangeTables = manifest.tables.some((table) => rangeTableSet.has(table));
    if (hasHashTables !== (manifest.hashModulus !== null))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hashModulus must be 16 exactly when hash tables are approved",
        path: ["hashModulus"],
      });
    if (hasRangeTables === (manifest.months.length === 0))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "months must be non-empty exactly when range tables are approved",
        path: ["months"],
      });
    if (!dependenciesShareIdentity(manifest.baseBundleDependencies))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "base bundle dependencies must share one exact identity",
        path: ["baseBundleDependencies"],
      });
    if (!dependencyOperationIdsAreExact(manifest.baseBundleDependencies))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "base dependency operation IDs must match their identities",
        path: ["baseBundleDependencies"],
      });
    if (
      manifest.baseBundleDependencies[0].databaseRole !== manifest.databaseRole
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "planner and base bundle database roles must match",
        path: ["databaseRole"],
      });
    const roles = [
      manifest.databaseRole,
      manifest.applicationRole,
      manifest.migrationRole,
    ];
    if (new Set(roles).size !== roles.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "database roles must be distinct",
        path: ["applicationRole"],
      });
    const profileTables = manifest.securityProfiles.map((item) => item.table);
    if (
      new Set(profileTables).size !== profileTables.length ||
      profileTables.length !== manifest.tables.length ||
      manifest.tables.some((table) => !profileTables.includes(table))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "security profiles must exactly match selected tables",
        path: ["securityProfiles"],
      });
  });

export type PartitionManifest = z.infer<typeof partitionManifestSchema>;
export type VerifiedPartitionManifest = {
  manifest: PartitionManifest;
  sha256: string;
};

export function securityProfileForTable(
  manifest: PartitionManifest,
  table: PartitionTable,
): PartitionSecurityProfile {
  const entry = manifest.securityProfiles.find((item) => item.table === table);
  if (!entry) failPartition("PARTITION_MANIFEST_SECURITY_PROFILE_MISSING");
  return entry.profile;
}

function assertSameSet(
  requested: string[],
  approved: string[],
  label: string,
): void {
  const requestedSet = new Set(requested);
  if (
    requested.length !== approved.length ||
    approved.some((value) => !requestedSet.has(value))
  )
    failPartition(`PARTITION_MANIFEST_${label.toUpperCase()}_SCOPE_MISMATCH`);
}

export function parseAndVerifyManifest(
  rawManifest: string,
  expectedSha256: string,
  options: PlannerOptions,
  now: Date,
): VerifiedPartitionManifest {
  if (!/^[a-fA-F0-9]{64}$/.test(expectedSha256))
    failPartition("PARTITION_MANIFEST_HASH_INVALID");
  const actualHash = createHash("sha256").update(rawManifest).digest("hex");
  if (actualHash !== expectedSha256.toLowerCase())
    failPartition("PARTITION_MANIFEST_HASH_MISMATCH");

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawManifest);
  } catch {
    failPartition("PARTITION_MANIFEST_INVALID");
  }
  const parsed = partitionManifestSchema.safeParse(parsedJson);
  if (!parsed.success) failPartition("PARTITION_MANIFEST_INVALID");
  const manifest = parsed.data;
  if (manifest.approvalId !== options.approvalId)
    failPartition("PARTITION_MANIFEST_APPROVAL_MISMATCH");
  if (manifest.applicationRole !== options.applicationRole)
    failPartition("PARTITION_MANIFEST_APPLICATION_ROLE_MISMATCH");
  if (manifest.migrationRole !== options.migrationRole)
    failPartition("PARTITION_MANIFEST_MIGRATION_ROLE_MISMATCH");
  if (manifest.environment !== options.environment)
    failPartition("PARTITION_MANIFEST_ENVIRONMENT_MISMATCH");
  const expiresAt = new Date(manifest.expiresAt).getTime();
  if (!Number.isFinite(expiresAt))
    failPartition("PARTITION_MANIFEST_EXPIRY_INVALID");
  if (expiresAt <= now.getTime())
    failPartition("PARTITION_MANIFEST_EXPIRED");

  assertSameSet(options.tables, manifest.tables, "table");
  assertSameSet(options.months, manifest.months, "month");
  assertSameSet(options.tenantIds, manifest.tenantIds, "tenant");
  if (manifest.hashModulus !== options.hashModulus)
    failPartition("PARTITION_MANIFEST_HASH_MODULUS_MISMATCH");
  return { manifest, sha256: actualHash };
}

export function assertManifestDatabase(
  manifest: PartitionManifest,
  database: string,
  databaseRole: string,
): void {
  if (manifest.database !== database)
    failPartition("PARTITION_MANIFEST_DATABASE_MISMATCH");
  if (manifest.databaseRole !== databaseRole)
    failPartition("PARTITION_MANIFEST_DATABASE_ROLE_MISMATCH");
}
