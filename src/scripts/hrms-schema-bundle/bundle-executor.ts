import type postgres from "postgres";
import { z } from "zod";
import { verifyBundleFileCatalog } from "./bundle-catalog";
import {
  buildLogicalBundleId,
  buildOperationId,
  type BundleFileName,
} from "./bundle-config";
import { BundleRunnerError, fail, safeFailureCode } from "./bundle-error";
import type { BundleSnapshot, SqlFileSnapshot } from "./bundle-files";
import {
  operationLedgerExists,
  readOperationDecision,
  verifyOperationLedger,
  type OperationIdentity,
} from "./bundle-ledger";
import {
  assertSelfCompletedOperation,
  insertRunningOperation,
  recordFailedOperation,
  transitionOperation,
} from "./bundle-ledger-write";
import type { VerifiedManifest } from "./bundle-manifest-schema";
import type { DatabaseIdentity } from "./bundle-database";

const lockRowsSchema = z.array(z.object({ acquired: z.boolean() }));
const unlockRowsSchema = z.array(z.object({ released: z.boolean() }));

export type FileApplyResult = {
  fileName: BundleFileName;
  status: "applied" | "verified-existing";
};

type ApplyContext = {
  manifest: VerifiedManifest;
  snapshot: BundleSnapshot;
  identity: DatabaseIdentity;
  logicalBundleId: string;
};

export function dependencySqlHash(
  files: SqlFileSnapshot[],
  fileName: BundleFileName,
): string {
  const index = files.findIndex((file) => file.name === fileName);
  if (index < 0) fail("RUNNER_DEPENDENCY_HASH_MISSING");
  if (index === 0) return "";
  const dependency = files[index - 1];
  if (!dependency) fail("RUNNER_DEPENDENCY_HASH_MISSING");
  return dependency.sha256;
}

function buildIdentity(
  context: ApplyContext,
  file: SqlFileSnapshot,
): OperationIdentity {
  return {
    operationId: buildOperationId(
      context.logicalBundleId,
      file.name,
      context.manifest.sha256,
    ),
    logicalBundleId: context.logicalBundleId,
    fileName: file.name,
    sqlHash: file.sha256,
    manifestHash: context.manifest.sha256,
    rootMigrationHash: context.snapshot.root.sha256,
    databaseName: context.identity.database,
    databaseRole: context.identity.databaseRole,
    serverVersion: context.identity.serverVersion,
  };
}

async function setTransactionContext(
  tx: postgres.TransactionSql,
  context: ApplyContext,
  current: OperationIdentity,
): Promise<void> {
  const dependencyHash = dependencySqlHash(
    context.snapshot.files,
    current.fileName,
  );
  await tx`
    SELECT
      set_config('lock_timeout', '5s', true),
      set_config('statement_timeout', '5min', true),
      set_config('idle_in_transaction_session_timeout', '60s', true),
      set_config('TimeZone', 'UTC', true),
      set_config('app.bootstrap_role', ${context.manifest.manifest.applicationRole}, true),
      set_config('app.hrms_migration_role', ${context.manifest.manifest.migrationRole}, true),
      set_config('app.hrms_bundle_operation_id', ${current.operationId}, true),
      set_config('app.hrms_bundle_id', ${current.logicalBundleId}, true),
      set_config('app.hrms_bundle_file_name', ${current.fileName}, true),
      set_config('app.hrms_bundle_sql_hash', ${current.sqlHash}, true),
      set_config('app.hrms_bundle_manifest_hash', ${current.manifestHash}, true),
      set_config('app.hrms_bundle_root_migration_hash', ${current.rootMigrationHash}, true),
      set_config('app.hrms_bundle_dependency_sql_hash', ${dependencyHash}, true)
  `;
}

async function verifyExistingFile(
  client: postgres.Sql,
  context: ApplyContext,
  current: OperationIdentity,
): Promise<void> {
  await client.begin(async (tx) => {
    await setTransactionContext(tx, context, current);
    if (current.fileName === "0000_hrms_profiles_workforce.sql")
      await verifyOperationLedger(
        tx,
        context.manifest.manifest.applicationRole,
        context.manifest.manifest.migrationRole,
      );
    await verifyBundleFileCatalog(
      tx,
      current.fileName,
      context.manifest.manifest.applicationRole,
      context.manifest.manifest.migrationRole,
      context.identity.databaseRole,
      "verified-existing",
    );
  });
}

async function executeFile(
  client: postgres.Sql,
  context: ApplyContext,
  file: SqlFileSnapshot,
  current: OperationIdentity,
): Promise<void> {
  await client.begin(async (tx) => {
    await setTransactionContext(tx, context, current);
    if (file.name !== "0000_hrms_profiles_workforce.sql")
      await insertRunningOperation(tx, current);
    await tx.unsafe(file.sql);
    if (file.name === "0000_hrms_profiles_workforce.sql") {
      await verifyOperationLedger(
        tx,
        context.manifest.manifest.applicationRole,
        context.manifest.manifest.migrationRole,
      );
      await verifyBundleFileCatalog(
        tx,
        file.name,
        context.manifest.manifest.applicationRole,
        context.manifest.manifest.migrationRole,
        context.identity.databaseRole,
        "initial-apply",
      );
      await assertSelfCompletedOperation(tx, current);
      return;
    }
    await transitionOperation(tx, current, "RUNNING", "VERIFYING");
    await verifyBundleFileCatalog(
      tx,
      file.name,
      context.manifest.manifest.applicationRole,
      context.manifest.manifest.migrationRole,
      context.identity.databaseRole,
      "initial-apply",
    );
    await transitionOperation(tx, current, "VERIFYING", "COMPLETE");
  });
}

async function tryRecordFailure(
  client: postgres.Sql,
  context: ApplyContext,
  current: OperationIdentity,
  failureCode: string,
): Promise<void> {
  try {
    await recordFailedOperation(
      client,
      current,
      context.manifest.manifest.applicationRole,
      context.manifest.manifest.migrationRole,
      failureCode,
    );
  } catch {
    return;
  }
}

async function applySingleFile(
  client: postgres.Sql,
  context: ApplyContext,
  file: SqlFileSnapshot,
): Promise<FileApplyResult> {
  const current = buildIdentity(context, file);
  try {
    const ledgerExists = await operationLedgerExists(client);
    if (!ledgerExists && file.name !== "0000_hrms_profiles_workforce.sql")
      fail("RUNNER_LEDGER_MISSING");
    let decision: "run" | "skip" = "run";
    if (ledgerExists) {
      await verifyOperationLedger(
        client,
        context.manifest.manifest.applicationRole,
        context.manifest.manifest.migrationRole,
      );
      decision = await readOperationDecision(client, current);
    }
    if (decision === "skip") {
      await verifyExistingFile(client, context, current);
      return { fileName: file.name, status: "verified-existing" };
    }
    await executeFile(client, context, file, current);
    return { fileName: file.name, status: "applied" };
  } catch (error: unknown) {
    const failureCode = safeFailureCode(error);
    await tryRecordFailure(client, context, current, failureCode);
    throw new BundleRunnerError(failureCode);
  }
}

export async function acquireBundleLock(
  client: postgres.Sql,
): Promise<string> {
  const lockKey = "streamlineos:hrms-schema-bundle:0000-0004";
  const rawRows: unknown = await client`
    SELECT pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) AS acquired
  `;
  if (lockRowsSchema.parse(rawRows)[0]?.acquired !== true)
    fail("RUNNER_ADVISORY_LOCK_BUSY");
  return lockKey;
}

export async function releaseBundleLock(
  client: postgres.Sql,
  lockKey: string,
): Promise<void> {
  const rawRows: unknown = await client`
    SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0)) AS released
  `;
  if (unlockRowsSchema.parse(rawRows)[0]?.released !== true)
    fail("RUNNER_ADVISORY_LOCK_RELEASE_FAILED");
}

export async function applyBundle(
  client: postgres.Sql,
  manifest: VerifiedManifest,
  snapshot: BundleSnapshot,
  identity: DatabaseIdentity,
  report: (result: FileApplyResult) => void,
): Promise<FileApplyResult[]> {
  const logicalBundleId = buildLogicalBundleId(
    manifest.manifest.bundleId,
    manifest.manifest.bundleVersion,
  );
  const context = { manifest, snapshot, identity, logicalBundleId };
  const lockKey = await acquireBundleLock(client);
  const results: FileApplyResult[] = [];
  try {
    for (const file of snapshot.files) {
      const result = await applySingleFile(client, context, file);
      results.push(result);
      report(result);
    }
    return results;
  } finally {
    await releaseBundleLock(client, lockKey);
  }
}
