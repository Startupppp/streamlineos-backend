import { createHash } from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";
import { failPartition } from "./partition-error";
import type { VerifiedPartitionManifest } from "./partition-manifest";
import type { BaseBundleDependency } from "./partition-provenance";

const dependencyRowsSchema = z.array(
  z.object({
    operation_id: z.string().min(1),
    bundle_id: z.string().min(1),
    file_name: z.string().min(1),
    sql_hash: z.string().regex(/^[A-Fa-f0-9]{64}$/),
    manifest_hash: z.string().regex(/^[A-Fa-f0-9]{64}$/),
    root_migration_hash: z.string().regex(/^[A-Fa-f0-9]{64}$/),
    state: z.string(),
    database_name: z.string().min(1),
    database_role: z.string().min(1),
    server_version_num: z.number().int().positive(),
    current_database_name: z.string().min(1),
    current_database_role: z.string().min(1),
    current_server_version: z.number().int().positive(),
  }),
);

export type BaseBundleIdentity = {
  logicalBundleId: string;
  rootMigrationSha256: string;
  databaseName: string;
  databaseRole: string;
  serverVersion: number;
  dependenciesSha256: string;
};

type DependencyRow = z.infer<typeof dependencyRowsSchema>[number];

function digestDependencies(
  dependencies: readonly BaseBundleDependency[],
): string {
  const canonical = dependencies
    .map((dependency) =>
      [
        dependency.operationId,
        dependency.logicalBundleId,
        dependency.rootMigrationName,
        dependency.rootMigrationSha256,
        dependency.fileName,
        dependency.sqlSha256,
        dependency.manifestSha256,
        dependency.databaseRole,
      ].join("\u0000"),
    )
    .join("\u0001");
  return createHash("sha256").update(canonical).digest("hex");
}

function expectedOperationId(dependency: BaseBundleDependency): string {
  return dependency.operationId;
}

function rowMatches(
  row: DependencyRow,
  dependency: BaseBundleDependency,
  database: string,
): boolean {
  return (
    row.operation_id === expectedOperationId(dependency) &&
    row.bundle_id === dependency.logicalBundleId &&
    row.file_name === dependency.fileName &&
    row.sql_hash.toLowerCase() === dependency.sqlSha256 &&
    row.manifest_hash.toLowerCase() === dependency.manifestSha256 &&
    row.root_migration_hash.toLowerCase() ===
      dependency.rootMigrationSha256 &&
    row.state === "COMPLETE" &&
    row.database_name === database &&
    row.database_role === dependency.databaseRole &&
    row.current_database_name === database &&
    row.current_database_role === dependency.databaseRole &&
    row.server_version_num === row.current_server_version
  );
}

export function assertBaseBundleDependencyRows(
  rawRows: unknown,
  verified: VerifiedPartitionManifest,
): BaseBundleIdentity {
  const rows = dependencyRowsSchema.safeParse(rawRows);
  if (!rows.success)
    failPartition("PARTITION_BASE_DEPENDENCY_ROWS_INVALID");
  const dependencies = verified.manifest.baseBundleDependencies;
  if (rows.data.length !== dependencies.length)
    failPartition("PARTITION_BASE_DEPENDENCY_COUNT_MISMATCH");
  const rowsByOperation = new Map(
    rows.data.map((row) => [row.operation_id, row]),
  );
  for (const dependency of dependencies) {
    const row = rowsByOperation.get(expectedOperationId(dependency));
    if (!row || !rowMatches(row, dependency, verified.manifest.database))
      failPartition("PARTITION_BASE_DEPENDENCY_IDENTITY_MISMATCH");
  }
  const first = dependencies[0];
  if (!first) failPartition("PARTITION_BASE_DEPENDENCY_COUNT_MISMATCH");
  return {
    logicalBundleId: first.logicalBundleId,
    rootMigrationSha256: first.rootMigrationSha256,
    databaseName: verified.manifest.database,
    databaseRole: first.databaseRole,
    serverVersion: rows.data[0]?.current_server_version ?? 0,
    dependenciesSha256: digestDependencies(dependencies),
  };
}

export async function verifyBaseBundleDependencies(
  client: postgres.Sql | postgres.TransactionSql,
  verified: VerifiedPartitionManifest,
): Promise<BaseBundleIdentity> {
  const operationIds = verified.manifest.baseBundleDependencies.map(
    expectedOperationId,
  );
  const rawRows: unknown = await client`
    SELECT operation_id, bundle_id, file_name, sql_hash, manifest_hash,
      root_migration_hash, state, database_name, database_role,
      server_version_num,
      current_database() AS current_database_name,
      current_user AS current_database_role,
      current_setting('server_version_num')::integer AS current_server_version
    FROM app.hrms_sql_bundle_operations
    WHERE operation_id = ANY(${operationIds}::text[])
    ORDER BY file_name
    FOR SHARE
  `;
  return assertBaseBundleDependencyRows(rawRows, verified);
}
