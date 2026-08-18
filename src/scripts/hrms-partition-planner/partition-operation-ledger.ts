import type postgres from "postgres";
import { z } from "zod";
import { failPartition } from "./partition-error";
import {
  decidePartitionOperation,
  partitionOperationMatches,
  partitionOperationRowsSchema,
  type PartitionOperationIdentity,
} from "./partition-operation-identity";

const affectedRowsSchema = z.array(z.object({ operation_id: z.string() }));

async function lockedOperationRows(
  tx: postgres.TransactionSql,
  current: PartitionOperationIdentity,
) {
  const rawRows: unknown = await tx`
    SELECT operation_id, approval_id, manifest_hash, base_bundle_id,
      root_migration_name, root_migration_hash, base_dependencies_hash,
      database_name, database_role, server_version_num, parent_table,
      child_table, partition_kind, range_from::text, range_to::text,
      hash_modulus, hash_remainder, security_profile, ddl_hash, state,
      attempts
    FROM app.hrms_partition_operations
    WHERE operation_id = ${current.operationId}
    FOR UPDATE
  `;
  const parsed = partitionOperationRowsSchema.safeParse(rawRows);
  if (!parsed.success) failPartition("PARTITION_LEDGER_ROWS_INVALID");
  return parsed.data;
}

function assertAffected(rawRows: unknown, operationId: string): void {
  const parsed = affectedRowsSchema.safeParse(rawRows);
  if (
    !parsed.success ||
    parsed.data.length !== 1 ||
    parsed.data[0]?.operation_id !== operationId
  )
    failPartition("PARTITION_LEDGER_WRITE_FAILED");
}

async function insertOperation(
  tx: postgres.TransactionSql,
  current: PartitionOperationIdentity,
  state: "RUNNING" | "FAILED",
  failureCode: string | null,
): Promise<void> {
  const isFailed = state === "FAILED";
  const rawRows: unknown = await tx`
    INSERT INTO app.hrms_partition_operations (
      operation_id, approval_id, manifest_hash, base_bundle_id,
      root_migration_name, root_migration_hash, base_dependencies_hash,
      database_name, database_role, server_version_num, parent_table,
      child_table, partition_kind, range_from, range_to, hash_modulus,
      hash_remainder, security_profile, ddl_hash, state, attempts,
      started_at, completed_at, last_error
    ) VALUES (
      ${current.operationId}, ${current.approvalId}, ${current.manifestHash},
      ${current.baseBundleId}, ${current.rootMigrationName},
      ${current.rootMigrationHash}, ${current.baseDependenciesHash},
      current_database(), current_user,
      current_setting('server_version_num')::integer,
      ${current.parentTable}, ${current.childTable}, ${current.partitionKind},
      ${current.rangeFrom}::date, ${current.rangeTo}::date,
      ${current.hashModulus}, ${current.hashRemainder},
      ${current.securityProfile}, ${current.ddlHash}, ${state}, 1,
      transaction_timestamp(),
      CASE WHEN ${isFailed} THEN clock_timestamp() ELSE NULL END,
      ${failureCode}
    )
    RETURNING operation_id
  `;
  assertAffected(rawRows, current.operationId);
}

async function resumeOperation(
  tx: postgres.TransactionSql,
  current: PartitionOperationIdentity,
): Promise<void> {
  const rawRows: unknown = await tx`
    UPDATE app.hrms_partition_operations
    SET state = 'RUNNING', attempts = attempts + 1,
      started_at = greatest(
        statement_timestamp(), started_at + interval '1 microsecond'
      ), completed_at = NULL,
      last_error = NULL
    WHERE operation_id = ${current.operationId}
      AND approval_id = ${current.approvalId}
      AND manifest_hash = ${current.manifestHash}
      AND base_bundle_id = ${current.baseBundleId}
      AND root_migration_name = ${current.rootMigrationName}
      AND root_migration_hash = ${current.rootMigrationHash}
      AND base_dependencies_hash = ${current.baseDependenciesHash}
      AND database_name = ${current.databaseName}
      AND database_name = current_database()
      AND database_role = ${current.databaseRole}
      AND database_role = current_user
      AND server_version_num = ${current.serverVersion}
      AND parent_table = ${current.parentTable}
      AND child_table = ${current.childTable}
      AND partition_kind = ${current.partitionKind}
      AND range_from IS NOT DISTINCT FROM ${current.rangeFrom}::date
      AND range_to IS NOT DISTINCT FROM ${current.rangeTo}::date
      AND hash_modulus IS NOT DISTINCT FROM ${current.hashModulus}
      AND hash_remainder IS NOT DISTINCT FROM ${current.hashRemainder}
      AND security_profile = ${current.securityProfile}
      AND ddl_hash = ${current.ddlHash}
      AND state = 'FAILED'
    RETURNING operation_id
  `;
  assertAffected(rawRows, current.operationId);
}

export async function claimPartitionOperation(
  tx: postgres.TransactionSql,
  current: PartitionOperationIdentity,
): Promise<"execute" | "complete"> {
  const rows = await lockedOperationRows(tx, current);
  const decision = decidePartitionOperation(rows, current);
  if (decision === "complete") return "complete";
  if (decision === "run") await insertOperation(tx, current, "RUNNING", null);
  else await resumeOperation(tx, current);
  return "execute";
}

export async function transitionPartitionOperation(
  tx: postgres.TransactionSql,
  current: PartitionOperationIdentity,
  from: "RUNNING" | "VERIFYING",
  to: "VERIFYING" | "COMPLETE",
): Promise<void> {
  const completes = to === "COMPLETE";
  const rawRows: unknown = await tx`
    UPDATE app.hrms_partition_operations
    SET state = ${to},
      completed_at = CASE WHEN ${completes} THEN clock_timestamp() ELSE NULL END,
      last_error = NULL
    WHERE operation_id = ${current.operationId}
      AND approval_id = ${current.approvalId}
      AND manifest_hash = ${current.manifestHash}
      AND base_bundle_id = ${current.baseBundleId}
      AND root_migration_name = ${current.rootMigrationName}
      AND root_migration_hash = ${current.rootMigrationHash}
      AND base_dependencies_hash = ${current.baseDependenciesHash}
      AND database_name = ${current.databaseName}
      AND database_name = current_database()
      AND database_role = ${current.databaseRole}
      AND database_role = current_user
      AND server_version_num = ${current.serverVersion}
      AND parent_table = ${current.parentTable}
      AND child_table = ${current.childTable}
      AND partition_kind = ${current.partitionKind}
      AND range_from IS NOT DISTINCT FROM ${current.rangeFrom}::date
      AND range_to IS NOT DISTINCT FROM ${current.rangeTo}::date
      AND hash_modulus IS NOT DISTINCT FROM ${current.hashModulus}
      AND hash_remainder IS NOT DISTINCT FROM ${current.hashRemainder}
      AND security_profile = ${current.securityProfile}
      AND ddl_hash = ${current.ddlHash}
      AND state = ${from}
    RETURNING operation_id
  `;
  assertAffected(rawRows, current.operationId);
}

async function updateFailedOperation(
  tx: postgres.TransactionSql,
  current: PartitionOperationIdentity,
  failureCode: string,
): Promise<void> {
  const rawRows: unknown = await tx`
    UPDATE app.hrms_partition_operations
    SET attempts = attempts + 1,
      started_at = greatest(
        statement_timestamp(), started_at + interval '1 microsecond'
      ),
      completed_at = greatest(
        statement_timestamp(), started_at + interval '1 microsecond'
      ),
      last_error = ${failureCode}
    WHERE operation_id = ${current.operationId}
      AND approval_id = ${current.approvalId}
      AND manifest_hash = ${current.manifestHash}
      AND base_bundle_id = ${current.baseBundleId}
      AND root_migration_name = ${current.rootMigrationName}
      AND root_migration_hash = ${current.rootMigrationHash}
      AND base_dependencies_hash = ${current.baseDependenciesHash}
      AND database_name = ${current.databaseName}
      AND database_name = current_database()
      AND database_role = ${current.databaseRole}
      AND database_role = current_user
      AND server_version_num = ${current.serverVersion}
      AND parent_table = ${current.parentTable}
      AND child_table = ${current.childTable}
      AND partition_kind = ${current.partitionKind}
      AND range_from IS NOT DISTINCT FROM ${current.rangeFrom}::date
      AND range_to IS NOT DISTINCT FROM ${current.rangeTo}::date
      AND hash_modulus IS NOT DISTINCT FROM ${current.hashModulus}
      AND hash_remainder IS NOT DISTINCT FROM ${current.hashRemainder}
      AND security_profile = ${current.securityProfile}
      AND ddl_hash = ${current.ddlHash}
      AND state = 'FAILED'
    RETURNING operation_id
  `;
  assertAffected(rawRows, current.operationId);
}

export async function recordPartitionOperationFailure(
  client: postgres.Sql,
  current: PartitionOperationIdentity,
  failureCode: string,
): Promise<boolean> {
  if (!/^[A-Z][A-Z0-9_.:-]{0,255}$/.test(failureCode)) return false;
  try {
    return await client.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '5s'");
      await tx.unsafe("SET LOCAL statement_timeout = '30s'");
      await tx.unsafe("SET LOCAL idle_in_transaction_session_timeout = '60s'");
      const rows = await lockedOperationRows(tx, current);
      const row = rows[0];
      if (rows.length > 1 || (row && !partitionOperationMatches(row, current)))
        return false;
      if (!row) {
        await insertOperation(tx, current, "FAILED", failureCode);
        return true;
      }
      if (row.state !== "FAILED") return false;
      await updateFailedOperation(tx, current, failureCode);
      return true;
    });
  } catch {
    return false;
  }
}
