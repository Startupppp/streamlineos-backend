import type postgres from "postgres";
import {
  bundleFileNames,
  downFileName,
  type BundleFileName,
} from "./bundle-config";
import type { DatabaseIdentity } from "./bundle-database";
import { fail } from "./bundle-error";
import type { BundleSnapshot } from "./bundle-files";
import { verifyOperationLedger } from "./bundle-ledger";
import {
  affectedRowsSchema,
  operationRowsSchema,
  type OperationRow,
} from "./bundle-ledger-schema";
import { verifyRolledBackCatalog } from "./bundle-rollback-catalog";
import type {
  BundleRollbackManifest,
  VerifiedRollbackManifest,
} from "./bundle-rollback-manifest-schema";
import {
  acquireBundleLock,
  releaseBundleLock,
} from "./bundle-executor";

type AppliedOperation = BundleRollbackManifest["appliedOperations"][number];

export type RollbackFileResult = {
  fileName: BundleFileName;
  status: "rolled-back" | "verified-existing";
};

type RollbackContext = {
  manifest: VerifiedRollbackManifest;
  snapshot: BundleSnapshot;
  identity: DatabaseIdentity;
};

export function assertRollbackStateOrder(
  states: OperationRow["state"][],
  throughIndex: number,
): void {
  let rolledBackSeen = false;
  let firstRolledBackIndex: number | null = null;
  for (const [index, state] of states.entries()) {
    if (state === "ROLLED_BACK") {
      rolledBackSeen = true;
      if (firstRolledBackIndex === null) firstRolledBackIndex = index;
    } else if (state !== "COMPLETE" || rolledBackSeen)
      fail("RUNNER_ROLLBACK_ORDER_INVALID");
  }
  if (
    firstRolledBackIndex !== null &&
    throughIndex > firstRolledBackIndex
  )
    fail("RUNNER_ROLLBACK_SCOPE_ALREADY_PASSED");
}

function assertOperationIdentity(
  row: OperationRow,
  expected: AppliedOperation,
  currentServerVersion: number,
): void {
  if (
    row.operation_id !== expected.operationId ||
    row.bundle_id !== expected.bundleId ||
    row.file_name !== expected.fileName ||
    row.sql_hash.toLowerCase() !== expected.sqlHash ||
    row.manifest_hash.toLowerCase() !== expected.applyManifestHash ||
    row.root_migration_hash.toLowerCase() !== expected.rootMigrationHash ||
    row.database_name !== expected.databaseName ||
    row.database_role !== expected.databaseRole ||
    row.server_version_num !== expected.serverVersionNum ||
    row.server_version_num !== currentServerVersion
  )
    fail("RUNNER_ROLLBACK_OPERATION_IDENTITY_MISMATCH");
}

async function readBoundOperations(
  client: postgres.Sql,
  context: RollbackContext,
): Promise<OperationRow[]> {
  const expected = context.manifest.manifest.appliedOperations;
  const operationIds = expected.map((operation) => operation.operationId);
  if (!expected[0]) fail("RUNNER_ROLLBACK_OPERATION_MISSING");
  const rawUnbound: unknown = await client`
    SELECT operation_id
    FROM app.hrms_sql_bundle_operations
    WHERE database_name = ${context.identity.database}
      AND database_role = ${context.identity.databaseRole}
      AND file_name = ANY(${bundleFileNames}::text[])
      AND state IN ('RUNNING', 'VERIFYING', 'COMPLETE')
      AND NOT (operation_id = ANY(${operationIds}::text[]))
  `;
  if (affectedRowsSchema.parse(rawUnbound).length > 0)
    fail("RUNNER_ROLLBACK_UNBOUND_OPERATION");
  const rawRows: unknown = await client`
    SELECT operation_id, bundle_id, file_name, sql_hash, manifest_hash,
      root_migration_hash, state, database_name, database_role,
      server_version_num
    FROM app.hrms_sql_bundle_operations
    WHERE operation_id = ANY(${operationIds}::text[])
    ORDER BY file_name
  `;
  const rows = operationRowsSchema.parse(rawRows);
  if (rows.length !== expected.length)
    fail("RUNNER_ROLLBACK_OPERATION_MISSING");
  const states: OperationRow["state"][] = [];
  for (const operation of expected) {
    const row = rows.find(
      (candidate) => candidate.operation_id === operation.operationId,
    );
    if (!row) fail("RUNNER_ROLLBACK_OPERATION_MISSING");
    assertOperationIdentity(row, operation, context.identity.serverVersion);
    states.push(row.state);
  }
  const throughIndex = bundleFileNames.indexOf(
    context.manifest.manifest.rollbackThrough,
  );
  assertRollbackStateOrder(states, throughIndex);
  return rows;
}

async function setRollbackContext(
  tx: postgres.TransactionSql,
  context: RollbackContext,
  operation: AppliedOperation,
): Promise<void> {
  await tx`
    SELECT
      set_config('lock_timeout', '5s', true),
      set_config('statement_timeout', '5min', true),
      set_config('idle_in_transaction_session_timeout', '60s', true),
      set_config('TimeZone', 'UTC', true),
      set_config('app.bootstrap_role', ${context.manifest.manifest.applicationRole}, true),
      set_config('app.hrms_migration_role', ${context.manifest.manifest.migrationRole}, true),
      set_config('app.hrms_bundle_operation_id', ${operation.operationId}, true),
      set_config('app.hrms_bundle_id', ${operation.bundleId}, true),
      set_config('app.hrms_bundle_file_name', ${operation.fileName}, true),
      set_config('app.hrms_bundle_sql_hash', ${operation.sqlHash}, true),
      set_config('app.hrms_bundle_manifest_hash', ${operation.applyManifestHash}, true),
      set_config('app.hrms_bundle_root_migration_hash', ${operation.rootMigrationHash}, true)
  `;
}

async function readLockedOperation(
  tx: postgres.TransactionSql,
  operation: AppliedOperation,
): Promise<OperationRow> {
  const rawRows: unknown = await tx`
    SELECT operation_id, bundle_id, file_name, sql_hash, manifest_hash,
      root_migration_hash, state, database_name, database_role,
      server_version_num
    FROM app.hrms_sql_bundle_operations
    WHERE operation_id = ${operation.operationId}
    FOR UPDATE
  `;
  const rows = operationRowsSchema.parse(rawRows);
  const row = rows[0];
  if (rows.length !== 1 || !row)
    fail("RUNNER_ROLLBACK_OPERATION_MISSING");
  return row;
}

async function verifyLedgerAndOperation(
  tx: postgres.TransactionSql,
  context: RollbackContext,
  operation: AppliedOperation,
  state: "COMPLETE" | "ROLLED_BACK",
): Promise<void> {
  await verifyOperationLedger(
    tx,
    context.manifest.manifest.applicationRole,
    context.manifest.manifest.migrationRole,
  );
  const row = await readLockedOperation(tx, operation);
  assertOperationIdentity(row, operation, context.identity.serverVersion);
  if (row.state !== state) fail("RUNNER_ROLLBACK_STATE_MISMATCH");
}

async function processOperation(
  client: postgres.Sql,
  context: RollbackContext,
  operation: AppliedOperation,
  alreadyRolledBack: boolean,
): Promise<RollbackFileResult> {
  const fileIndex = bundleFileNames.indexOf(operation.fileName);
  const down = context.snapshot.downFiles[fileIndex];
  if (!down || down.name !== downFileName(operation.fileName))
    fail("RUNNER_ROLLBACK_FILE_MISSING");
  await client.begin(async (tx) => {
    await setRollbackContext(tx, context, operation);
    await verifyLedgerAndOperation(
      tx,
      context,
      operation,
      alreadyRolledBack ? "ROLLED_BACK" : "COMPLETE",
    );
    if (!alreadyRolledBack) await tx.unsafe(down.sql);
    await verifyLedgerAndOperation(tx, context, operation, "ROLLED_BACK");
    await verifyRolledBackCatalog(
      tx,
      operation.fileName,
      context.manifest.manifest.applicationRole,
      context.manifest.manifest.migrationRole,
      context.identity.databaseRole,
    );
  });
  return {
    fileName: operation.fileName,
    status: alreadyRolledBack ? "verified-existing" : "rolled-back",
  };
}

export async function rollbackBundle(
  client: postgres.Sql,
  manifest: VerifiedRollbackManifest,
  snapshot: BundleSnapshot,
  identity: DatabaseIdentity,
  report: (result: RollbackFileResult) => void,
): Promise<RollbackFileResult[]> {
  const context = { manifest, snapshot, identity };
  const lockKey = await acquireBundleLock(client);
  const results: RollbackFileResult[] = [];
  try {
    const rows = await readBoundOperations(client, context);
    const throughIndex = bundleFileNames.indexOf(
      manifest.manifest.rollbackThrough,
    );
    const selected = manifest.manifest.appliedOperations.slice(throughIndex);
    for (const operation of [...selected].reverse()) {
      const row = rows.find(
        (candidate) => candidate.operation_id === operation.operationId,
      );
      if (!row) fail("RUNNER_ROLLBACK_OPERATION_MISSING");
      const result = await processOperation(
        client,
        context,
        operation,
        row.state === "ROLLED_BACK",
      );
      results.push(result);
      report(result);
    }
    return results;
  } finally {
    await releaseBundleLock(client, lockKey);
  }
}
