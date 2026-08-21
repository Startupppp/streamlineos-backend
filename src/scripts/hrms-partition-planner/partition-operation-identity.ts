import { createHash } from "node:crypto";
import { z } from "zod";
import {
  partitionFamilies,
  type PartitionSecurityProfile,
} from "./partition-config";
import { failPartition } from "./partition-error";
import type { VerifiedPartitionManifest } from "./partition-manifest";
import type { PartitionPlanItem } from "./partition-plan";
import { installPartitionHelpersSql } from "./partition-sql";
import type { BaseBundleIdentity } from "./partition-dependencies";

export type PartitionOperationIdentity = {
  operationId: string;
  approvalId: string;
  manifestHash: string;
  baseBundleId: string;
  rootMigrationName: string;
  rootMigrationHash: string;
  baseDependenciesHash: string;
  databaseName: string;
  databaseRole: string;
  serverVersion: number;
  parentTable: string;
  childTable: string;
  partitionKind: "RANGE" | "HASH";
  rangeFrom: string | null;
  rangeTo: string | null;
  hashModulus: number | null;
  hashRemainder: number | null;
  securityProfile: PartitionSecurityProfile;
  ddlHash: string;
};

export const partitionOperationRowsSchema = z.array(
  z.object({
    operation_id: z.string().min(1),
    approval_id: z.string().min(1),
    manifest_hash: z.string().regex(/^[A-Fa-f0-9]{64}$/),
    base_bundle_id: z.string().min(1),
    root_migration_name: z.string().min(1),
    root_migration_hash: z.string().regex(/^[A-Fa-f0-9]{64}$/),
    base_dependencies_hash: z.string().regex(/^[A-Fa-f0-9]{64}$/),
    database_name: z.string().min(1),
    database_role: z.string().min(1),
    server_version_num: z.number().int().positive(),
    parent_table: z.string().min(1),
    child_table: z.string().min(1),
    partition_kind: z.enum(["RANGE", "HASH"]),
    range_from: z.string().nullable(),
    range_to: z.string().nullable(),
    hash_modulus: z.number().int().nullable(),
    hash_remainder: z.number().int().nullable(),
    security_profile: z.literal("base-owner-only-v1"),
    ddl_hash: z.string().regex(/^[A-Fa-f0-9]{64}$/),
    state: z.enum(["RUNNING", "VERIFYING", "COMPLETE", "FAILED"]),
    attempts: z.number().int().positive(),
  }),
);

export type PartitionOperationRow = z.infer<
  typeof partitionOperationRowsSchema
>[number];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function operationBound(item: PartitionPlanItem): string[] {
  if (item.kind === "range")
    return [item.kind, item.parent, item.child, item.from, item.to];
  return [
    item.kind,
    item.parent,
    item.child,
    String(item.modulus),
    String(item.remainder),
  ];
}

export function buildPartitionOperationIdentity(
  item: PartitionPlanItem,
  verified: VerifiedPartitionManifest,
  base: BaseBundleIdentity,
  securityProfile: PartitionSecurityProfile,
): PartitionOperationIdentity {
  const dependency = verified.manifest.baseBundleDependencies[0];
  if (!dependency) failPartition("PARTITION_BASE_DEPENDENCY_COUNT_MISMATCH");
  const family = partitionFamilies[item.parent];
  const recipeHash = sha256(
    JSON.stringify({
      helpers: sha256(installPartitionHelpersSql),
      family,
      securityProfile,
      bound: operationBound(item),
      baseDependenciesHash: base.dependenciesSha256,
    }),
  );
  const logicalOperationId = [
    "hrms-partition@1",
    verified.manifest.approvalId,
    item.parent,
    item.child,
    verified.sha256,
  ].join(":");
  return {
    operationId: logicalOperationId,
    approvalId: verified.manifest.approvalId,
    manifestHash: verified.sha256,
    baseBundleId: base.logicalBundleId,
    rootMigrationName: dependency.rootMigrationName,
    rootMigrationHash: base.rootMigrationSha256,
    baseDependenciesHash: base.dependenciesSha256,
    databaseName: base.databaseName,
    databaseRole: base.databaseRole,
    serverVersion: base.serverVersion,
    parentTable: item.parent,
    childTable: item.child,
    partitionKind: item.kind === "range" ? "RANGE" : "HASH",
    rangeFrom: item.kind === "range" ? item.from : null,
    rangeTo: item.kind === "range" ? item.to : null,
    hashModulus: item.kind === "hash" ? item.modulus : null,
    hashRemainder: item.kind === "hash" ? item.remainder : null,
    securityProfile,
    ddlHash: recipeHash,
  };
}

export function partitionOperationMatches(
  row: PartitionOperationRow,
  current: PartitionOperationIdentity,
): boolean {
  return (
    row.operation_id === current.operationId &&
    row.approval_id === current.approvalId &&
    row.manifest_hash.toLowerCase() === current.manifestHash &&
    row.base_bundle_id === current.baseBundleId &&
    row.root_migration_name === current.rootMigrationName &&
    row.root_migration_hash.toLowerCase() === current.rootMigrationHash &&
    row.base_dependencies_hash.toLowerCase() === current.baseDependenciesHash &&
    row.database_name === current.databaseName &&
    row.database_role === current.databaseRole &&
    row.server_version_num === current.serverVersion &&
    row.parent_table === current.parentTable &&
    row.child_table === current.childTable &&
    row.partition_kind === current.partitionKind &&
    row.range_from === current.rangeFrom &&
    row.range_to === current.rangeTo &&
    row.hash_modulus === current.hashModulus &&
    row.hash_remainder === current.hashRemainder &&
    row.security_profile === current.securityProfile &&
    row.ddl_hash.toLowerCase() === current.ddlHash
  );
}

export function decidePartitionOperation(
  rows: PartitionOperationRow[],
  current: PartitionOperationIdentity,
): "run" | "resume" | "complete" {
  if (rows.length === 0) return "run";
  const row = rows[0];
  if (rows.length !== 1 || !row || !partitionOperationMatches(row, current))
    failPartition("PARTITION_OPERATION_IDENTITY_MISMATCH");
  if (row.state === "COMPLETE") return "complete";
  if (row.state === "FAILED") return "resume";
  failPartition("PARTITION_OPERATION_ACTIVE");
}
