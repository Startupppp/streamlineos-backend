import type postgres from "postgres";
import type { BundleFileName } from "./bundle-config";
import { fail } from "./bundle-error";
import { verifyLedgerAccess } from "./bundle-ledger-access";
import {
  existsRowsSchema,
  ledgerColumnRowsSchema,
  ledgerConstraintRowsSchema,
  operationRowsSchema,
  type OperationRow,
} from "./bundle-ledger-schema";

export type OperationIdentity = {
  operationId: string;
  logicalBundleId: string;
  fileName: BundleFileName;
  sqlHash: string;
  manifestHash: string;
  rootMigrationHash: string;
  databaseName: string;
  databaseRole: string;
  serverVersion: number;
};

const expectedLedgerColumns = new Map<string, { type: string; notNull: boolean }>([
  ["operation_id", { type: "text", notNull: true }],
  ["bundle_id", { type: "text", notNull: true }],
  ["file_name", { type: "text", notNull: true }],
  ["sql_hash", { type: "text", notNull: true }],
  ["manifest_hash", { type: "text", notNull: true }],
  ["root_migration_hash", { type: "text", notNull: true }],
  ["state", { type: "text", notNull: true }],
  ["attempts", { type: "integer", notNull: true }],
  ["database_name", { type: "text", notNull: true }],
  ["database_role", { type: "text", notNull: true }],
  ["server_version_num", { type: "integer", notNull: true }],
  ["started_at", { type: "timestamp with time zone", notNull: true }],
  ["completed_at", { type: "timestamp with time zone", notNull: false }],
  ["last_error", { type: "text", notNull: false }],
]);

const expectedLedgerConstraints = new Map<string, string>([
  ["hrms_sql_bundle_operations_pkey", "p"],
  ["chk_hrms_sql_bundle_operations_identity", "c"],
  ["chk_hrms_sql_bundle_operations_hashes", "c"],
  ["chk_hrms_sql_bundle_operations_state", "c"],
  ["chk_hrms_sql_bundle_operations_attempts", "c"],
  ["chk_hrms_sql_bundle_operations_server_version", "c"],
  ["chk_hrms_sql_bundle_operations_error", "c"],
  ["chk_hrms_sql_bundle_operations_timestamps", "c"],
  ["chk_hrms_sql_bundle_operations_shape", "c"],
]);

export async function operationLedgerExists(
  client: postgres.Sql | postgres.TransactionSql,
): Promise<boolean> {
  const rawRows: unknown = await client`
    SELECT to_regclass('app.hrms_sql_bundle_operations') IS NOT NULL AS exists
  `;
  const rows = existsRowsSchema.parse(rawRows);
  return rows[0]?.exists === true;
}

export async function verifyOperationLedger(
  client: postgres.Sql | postgres.TransactionSql,
  applicationRole: string,
  migrationRole: string,
): Promise<void> {
  const rawColumns: unknown = await client`
    SELECT attribute.attname AS column_name,
      format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
      attribute.attnotnull AS not_null
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'app'
      AND relation.relname = 'hrms_sql_bundle_operations'
      AND relation.relkind = 'r'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY attribute.attnum
  `;
  const columns = ledgerColumnRowsSchema.parse(rawColumns);
  if (columns.length !== expectedLedgerColumns.size)
    fail("RUNNER_LEDGER_SHAPE_MISMATCH");
  for (const column of columns) {
    const expected = expectedLedgerColumns.get(column.column_name);
    if (
      !expected ||
      expected.type !== column.data_type ||
      expected.notNull !== column.not_null
    )
      fail("RUNNER_LEDGER_SHAPE_MISMATCH");
  }

  const rawConstraints: unknown = await client`
    SELECT catalog_constraint.conname AS constraint_name,
      catalog_constraint.contype::text AS constraint_type,
      catalog_constraint.convalidated AS validated
    FROM pg_constraint catalog_constraint
    WHERE catalog_constraint.conrelid = 'app.hrms_sql_bundle_operations'::regclass
    ORDER BY catalog_constraint.conname
  `;
  const constraints = ledgerConstraintRowsSchema.parse(rawConstraints);
  if (constraints.length !== expectedLedgerConstraints.size)
    fail("RUNNER_LEDGER_SHAPE_MISMATCH");
  for (const constraint of constraints) {
    if (
      expectedLedgerConstraints.get(constraint.constraint_name) !==
        constraint.constraint_type ||
      !constraint.validated
    )
      fail("RUNNER_LEDGER_SHAPE_MISMATCH");
  }

  await verifyLedgerAccess(client, applicationRole, migrationRole);
}

export function decideExistingOperation(
  rows: OperationRow[],
  current: OperationIdentity,
): "run" | "skip" {
  for (const row of rows) {
    if (
      (row.state === "COMPLETE" || row.state === "ROLLED_BACK") &&
      (row.sql_hash.toLowerCase() !== current.sqlHash ||
        row.root_migration_hash.toLowerCase() !== current.rootMigrationHash ||
        row.database_name !== current.databaseName ||
        row.database_role !== current.databaseRole)
    )
      fail("RUNNER_PRIOR_COMPLETE_IDENTITY_MISMATCH");
  }
  if (rows.some((row) => row.state === "RUNNING" || row.state === "VERIFYING"))
    fail("RUNNER_PRIOR_OPERATION_ACTIVE");

  const sameOperation = rows.find(
    (row) => row.operation_id === current.operationId,
  );
  if (sameOperation) {
    if (
      sameOperation.bundle_id !== current.logicalBundleId ||
      sameOperation.file_name !== current.fileName ||
      sameOperation.sql_hash.toLowerCase() !== current.sqlHash ||
      sameOperation.manifest_hash.toLowerCase() !== current.manifestHash ||
      sameOperation.root_migration_hash.toLowerCase() !== current.rootMigrationHash ||
      sameOperation.database_name !== current.databaseName ||
      sameOperation.database_role !== current.databaseRole ||
      sameOperation.server_version_num !== current.serverVersion
    )
      fail("RUNNER_OPERATION_IDENTITY_MISMATCH");
    if (sameOperation.state === "FAILED")
      fail("RUNNER_APPROVAL_ALREADY_FAILED");
  }
  if (rows.some((row) => row.state === "COMPLETE")) return "skip";
  return "run";
}

export async function readOperationDecision(
  client: postgres.Sql,
  current: OperationIdentity,
): Promise<"run" | "skip"> {
  const rawRows: unknown = await client`
    SELECT operation_id, bundle_id, file_name, sql_hash, manifest_hash,
      root_migration_hash, state, database_name, database_role,
      server_version_num
    FROM app.hrms_sql_bundle_operations
    WHERE bundle_id = ${current.logicalBundleId}
      AND file_name = ${current.fileName}
    ORDER BY started_at, operation_id
  `;
  return decideExistingOperation(operationRowsSchema.parse(rawRows), current);
}
