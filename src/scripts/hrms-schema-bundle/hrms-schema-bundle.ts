import postgres from "postgres";
import { readAndVerifyDatabaseIdentity, verifyRootMigration } from "./bundle-database";
import { directDatabaseUrlSchema } from "./bundle-environment-schema";
import { fail, safeFailureCode } from "./bundle-error";
import { applyBundle, type FileApplyResult } from "./bundle-executor";
import { loadBundleSnapshot } from "./bundle-files";
import {
  assertApplyApproval,
  assertManifestNotExpired,
  loadAndVerifyBundleManifest,
  type VerifiedManifest,
} from "./bundle-manifest-schema";
import { parseBundleOptions, type BundleOptions } from "./bundle-options";
import {
  rollbackBundle,
  type RollbackFileResult,
} from "./bundle-rollback-executor";
import {
  loadAndVerifyRollbackManifest,
  type VerifiedRollbackManifest,
} from "./bundle-rollback-manifest-schema";

const usage = `
HRMS SQL-managed schema bundle runner

Dry run without database access:
  pnpm hrms:schema-bundle
  pnpm hrms:schema-bundle --manifest=approved.json --manifest-sha256=<sha256>

Apply the exact approved bundle:
  pnpm hrms:schema-bundle --apply --manifest=approved.json --manifest-sha256=<sha256>

Rollback an exact contiguous reverse suffix:
  pnpm hrms:schema-bundle --rollback --rollback-through=0002_hrms_leave_ledger.sql --manifest=rollback.json --manifest-sha256=<sha256>

Production apply or rollback additionally requires --ack-production.
DIRECT_DATABASE_URL is required only for database mutations.

The strict manifest binds manifestVersion=1, bundleId, bundleVersion,
environment, database,
databaseRole, applicationRole, migrationRole, rootMigration name and SHA-256,
serverVersion min/max, approvalId, expiresAt, and the ordered 0000..0004 files.
A strict rollback manifest additionally binds action=rollback, the exact applied
operation identity prefix, rollbackThrough, and all ordered down-file hashes.
`;

function normalizeDatabaseUrl(value: string): string {
  if (!/\.neon\.tech/i.test(value)) return value;
  const parsed = new URL(value);
  parsed.searchParams.delete("channel_binding");
  return parsed.toString();
}

function createClient(connectionString: string): postgres.Sql {
  const options = {
    prepare: false,
    max: 1,
    idle_timeout: 10,
    connect_timeout: 30,
    onnotice: () => undefined,
  };
  if (/\.neon\.tech/i.test(connectionString))
    return postgres(connectionString, { ...options, ssl: "require" });
  return postgres(connectionString, options);
}

function loadManifest(
  options: BundleOptions,
  now: Date,
  snapshot: ReturnType<typeof loadBundleSnapshot>,
): VerifiedManifest | null {
  if (options.manifestPath === null || options.manifestSha256 === null) return null;
  return loadAndVerifyBundleManifest(
    options.manifestPath,
    options.manifestSha256,
    snapshot,
    now,
  );
}

function reportFile(result: FileApplyResult): void {
  process.stdout.write(`${JSON.stringify({
    mode: "apply",
    status: result.status,
    file: result.fileName,
  })}\n`);
}

function reportRollbackFile(result: RollbackFileResult): void {
  process.stdout.write(`${JSON.stringify({
    mode: "rollback",
    status: result.status,
    file: result.fileName,
  })}\n`);
}

async function runApply(
  options: BundleOptions,
  verifiedManifest: VerifiedManifest,
  snapshot: ReturnType<typeof loadBundleSnapshot>,
): Promise<void> {
  assertApplyApproval(
    verifiedManifest.manifest,
    options.acknowledgeProduction,
    process.env.NODE_ENV,
  );
  const parsedUrl = directDatabaseUrlSchema.safeParse(
    process.env.DIRECT_DATABASE_URL,
  );
  if (!parsedUrl.success) throw parsedUrl.error;
  const rootClient = createClient(normalizeDatabaseUrl(parsedUrl.data));
  const client = await rootClient.reserve();
  try {
    const identity = await readAndVerifyDatabaseIdentity(
      client,
      verifiedManifest.manifest,
    );
    await verifyRootMigration(client, snapshot.root);
    assertManifestNotExpired(verifiedManifest.manifest, new Date());
    process.stdout.write(`${JSON.stringify({
      mode: "apply",
      status: "approval-validated",
      manifestVersion: verifiedManifest.manifest.manifestVersion,
      manifestSha256: verifiedManifest.sha256,
      rootMigrationSha256: snapshot.root.sha256,
      fileCount: snapshot.files.length,
    })}\n`);
    const results = await applyBundle(
      client,
      verifiedManifest,
      snapshot,
      identity,
      reportFile,
    );
    process.stdout.write(`${JSON.stringify({
      mode: "apply",
      status: "complete",
      fileCount: results.length,
    })}\n`);
  } finally {
    client.release();
    await rootClient.end({ timeout: 5 });
  }
}

async function runRollback(
  options: BundleOptions,
  verifiedManifest: VerifiedRollbackManifest,
  snapshot: ReturnType<typeof loadBundleSnapshot>,
): Promise<void> {
  assertApplyApproval(
    verifiedManifest.manifest,
    options.acknowledgeProduction,
    process.env.NODE_ENV,
  );
  if (options.rollbackThrough !== verifiedManifest.manifest.rollbackThrough)
    fail("RUNNER_ROLLBACK_SCOPE_MISMATCH");
  const parsedUrl = directDatabaseUrlSchema.safeParse(
    process.env.DIRECT_DATABASE_URL,
  );
  if (!parsedUrl.success) throw parsedUrl.error;
  const rootClient = createClient(normalizeDatabaseUrl(parsedUrl.data));
  const client = await rootClient.reserve();
  try {
    const identity = await readAndVerifyDatabaseIdentity(
      client,
      verifiedManifest.manifest,
    );
    await verifyRootMigration(client, snapshot.root);
    assertManifestNotExpired(verifiedManifest.manifest, new Date());
    process.stdout.write(`${JSON.stringify({
      mode: "rollback",
      status: "approval-validated",
      manifestVersion: verifiedManifest.manifest.manifestVersion,
      manifestSha256: verifiedManifest.sha256,
      rollbackThrough: verifiedManifest.manifest.rollbackThrough,
      operationCount: verifiedManifest.manifest.appliedOperations.length,
    })}\n`);
    const results = await rollbackBundle(
      client,
      verifiedManifest,
      snapshot,
      identity,
      reportRollbackFile,
    );
    process.stdout.write(`${JSON.stringify({
      mode: "rollback",
      status: "complete",
      fileCount: results.length,
    })}\n`);
  } finally {
    client.release();
    await rootClient.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const parsed = parseBundleOptions(process.argv.slice(2));
  if (parsed.kind === "help") {
    process.stdout.write(usage);
    return;
  }
  const snapshot = loadBundleSnapshot();
  if (parsed.options.rollback) {
    if (
      parsed.options.manifestPath === null ||
      parsed.options.manifestSha256 === null
    )
      throw new Error("rollback manifest required");
    const rollbackManifest = loadAndVerifyRollbackManifest(
      parsed.options.manifestPath,
      parsed.options.manifestSha256,
      snapshot,
      new Date(),
    );
    await runRollback(parsed.options, rollbackManifest, snapshot);
    return;
  }
  const verifiedManifest = loadManifest(parsed.options, new Date(), snapshot);
  if (!parsed.options.apply) {
    process.stdout.write(`${JSON.stringify({
      mode: "dry-run",
      status: "ready",
      databaseAccessed: false,
      manifestVerified: verifiedManifest !== null,
      manifestVersion: verifiedManifest?.manifest.manifestVersion ?? null,
      rootMigration: snapshot.root,
      files: snapshot.files.map((file) => ({
        name: file.name,
        sha256: file.sha256,
      })),
      downFiles: snapshot.downFiles.map((file) => ({
        name: file.name,
        sha256: file.sha256,
      })),
    }, null, 2)}\n`);
    return;
  }
  if (!verifiedManifest) throw new Error("manifest required");
  await runApply(parsed.options, verifiedManifest, snapshot);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    status: "failed",
    code: safeFailureCode(error),
  })}\n`);
  process.exitCode = 1;
});
