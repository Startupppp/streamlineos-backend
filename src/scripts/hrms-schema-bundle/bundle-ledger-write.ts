import type postgres from "postgres";
import { fail } from "./bundle-error";
import {
  affectedRowsSchema,
  operationRowsSchema,
} from "./bundle-ledger-schema";
import {
  operationLedgerExists,
  verifyOperationLedger,
  type OperationIdentity,
} from "./bundle-ledger";

export async function insertRunningOperation(
  tx: postgres.TransactionSql,
  current: OperationIdentity,
): Promise<void> {
  const rawRows: unknown = await tx`
    INSERT INTO app.hrms_sql_bundle_operations AS operation (
      operation_id, bundle_id, file_name, sql_hash, manifest_hash,
      root_migration_hash, state, attempts, database_name, database_role,
      server_version_num, started_at, completed_at, last_error
    ) VALUES (
      ${current.operationId}, ${current.logicalBundleId}, ${current.fileName},
      ${current.sqlHash}, ${current.manifestHash}, ${current.rootMigrationHash},
      'RUNNING', 1, current_database(), current_user,
      current_setting('server_version_num')::integer,
      transaction_timestamp(), NULL, NULL
    )
    ON CONFLICT (operation_id) DO UPDATE
    SET state = 'RUNNING',
      attempts = operation.attempts + 1,
      started_at = greatest(
        statement_timestamp(),
        operation.started_at + interval '1 microsecond'
      ),
      completed_at = NULL,
      last_error = NULL
    WHERE operation.state = 'ROLLED_BACK'
      AND operation.bundle_id = EXCLUDED.bundle_id
      AND operation.file_name = EXCLUDED.file_name
      AND operation.sql_hash = EXCLUDED.sql_hash
      AND operation.manifest_hash = EXCLUDED.manifest_hash
      AND operation.root_migration_hash = EXCLUDED.root_migration_hash
      AND operation.database_name = EXCLUDED.database_name
      AND operation.database_role = EXCLUDED.database_role
      AND operation.server_version_num = EXCLUDED.server_version_num
    RETURNING operation_id
  `;
  if (affectedRowsSchema.parse(rawRows)[0]?.operation_id !== current.operationId)
    fail("RUNNER_LEDGER_INSERT_FAILED");
}

export async function transitionOperation(
  tx: postgres.TransactionSql,
  current: OperationIdentity,
  from: "RUNNING" | "VERIFYING",
  to: "VERIFYING" | "COMPLETE",
): Promise<void> {
  const completedAt = to === "COMPLETE";
  const rawRows: unknown = await tx`
    UPDATE app.hrms_sql_bundle_operations
    SET state = ${to},
      completed_at = CASE WHEN ${completedAt} THEN clock_timestamp() ELSE NULL END,
      last_error = NULL
    WHERE operation_id = ${current.operationId}
      AND bundle_id = ${current.logicalBundleId}
      AND file_name = ${current.fileName}
      AND sql_hash = ${current.sqlHash}
      AND manifest_hash = ${current.manifestHash}
      AND root_migration_hash = ${current.rootMigrationHash}
      AND state = ${from}
    RETURNING operation_id
  `;
  if (affectedRowsSchema.parse(rawRows)[0]?.operation_id !== current.operationId)
    fail("RUNNER_LEDGER_TRANSITION_FAILED");
}

export async function assertSelfCompletedOperation(
  tx: postgres.TransactionSql,
  current: OperationIdentity,
): Promise<void> {
  const rawRows: unknown = await tx`
    SELECT operation_id, bundle_id, file_name, sql_hash, manifest_hash,
      root_migration_hash, state, database_name, database_role,
      server_version_num
    FROM app.hrms_sql_bundle_operations
    WHERE operation_id = ${current.operationId}
  `;
  const rows = operationRowsSchema.parse(rawRows);
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    row.bundle_id !== current.logicalBundleId ||
    row.file_name !== current.fileName ||
    row.sql_hash.toLowerCase() !== current.sqlHash ||
    row.manifest_hash.toLowerCase() !== current.manifestHash ||
    row.root_migration_hash.toLowerCase() !== current.rootMigrationHash ||
    row.state !== "COMPLETE" ||
    row.database_name !== current.databaseName ||
    row.database_role !== current.databaseRole ||
    row.server_version_num !== current.serverVersion
  )
    fail("RUNNER_0000_SELF_COMPLETION_MISMATCH");
}

export async function recordFailedOperation(
  client: postgres.Sql,
  current: OperationIdentity,
  applicationRole: string,
  migrationRole: string,
  failureCode: string,
): Promise<boolean> {
  return client.begin(async (tx) => {
    if (!(await operationLedgerExists(tx))) return false;
    await tx`
      SELECT
        set_config('app.bootstrap_role', ${applicationRole}, true),
        set_config('app.hrms_migration_role', ${migrationRole}, true),
        set_config('app.hrms_bundle_operation_id', ${current.operationId}, true),
        set_config('app.hrms_bundle_id', ${current.logicalBundleId}, true),
        set_config('app.hrms_bundle_file_name', ${current.fileName}, true),
        set_config('app.hrms_bundle_sql_hash', ${current.sqlHash}, true),
        set_config('app.hrms_bundle_manifest_hash', ${current.manifestHash}, true),
        set_config('app.hrms_bundle_root_migration_hash', ${current.rootMigrationHash}, true)
    `;
    await verifyOperationLedger(tx, applicationRole, migrationRole);
    const rawResumedFailure: unknown = await tx`
      UPDATE app.hrms_sql_bundle_operations
      SET state = 'FAILED',
        attempts = attempts + 1,
        started_at = greatest(
          statement_timestamp(),
          started_at + interval '1 microsecond'
        ),
        completed_at = greatest(
          statement_timestamp(),
          started_at + interval '1 microsecond'
        ),
        last_error = ${failureCode}
      WHERE operation_id = ${current.operationId}
        AND bundle_id = ${current.logicalBundleId}
        AND file_name = ${current.fileName}
        AND sql_hash = ${current.sqlHash}
        AND manifest_hash = ${current.manifestHash}
        AND root_migration_hash = ${current.rootMigrationHash}
        AND database_name = current_database()
        AND database_role = current_user
        AND server_version_num = current_setting('server_version_num')::integer
        AND state = 'ROLLED_BACK'
      RETURNING operation_id
    `;
    if (
      affectedRowsSchema.parse(rawResumedFailure)[0]?.operation_id ===
      current.operationId
    )
      return true;
    const rawExisting: unknown = await tx`
      SELECT operation_id FROM app.hrms_sql_bundle_operations
      WHERE operation_id = ${current.operationId}
    `;
    if (affectedRowsSchema.parse(rawExisting).length > 0) return false;
    const rawRows: unknown = await tx`
      INSERT INTO app.hrms_sql_bundle_operations (
        operation_id, bundle_id, file_name, sql_hash, manifest_hash,
        root_migration_hash, state, attempts, database_name, database_role,
        server_version_num, started_at, completed_at, last_error
      ) VALUES (
        ${current.operationId}, ${current.logicalBundleId}, ${current.fileName},
        ${current.sqlHash}, ${current.manifestHash}, ${current.rootMigrationHash},
        'FAILED', 1, current_database(), current_user,
        current_setting('server_version_num')::integer,
        transaction_timestamp(), clock_timestamp(), ${failureCode}
      )
      RETURNING operation_id
    `;
    return affectedRowsSchema.parse(rawRows)[0]?.operation_id === current.operationId;
  });
}
