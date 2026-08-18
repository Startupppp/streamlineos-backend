import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { z } from "zod";
import {
  assertAttendanceSecurityReady,
  needsAttendanceSecurityVerification,
} from "./attendance-security-verification";
import {
  assertTenantAllowlist,
  readDatabaseIdentity,
} from "./partition-catalog";
import {
  applyPartitionPlan,
  type PartitionApplyResult,
} from "./partition-executor";
import { safePartitionFailureCode } from "./partition-error";
import {
  assertManifestDatabase,
  parseAndVerifyManifest,
  securityProfileForTable,
  type VerifiedPartitionManifest,
} from "./partition-manifest";
import { parseCliOptions, type PlannerOptions } from "./partition-options";
import { buildPartitionPlan } from "./partition-plan";

const usage = `
HRMS partition planner

Range allowlist: attendance_events, attendance_event_evidence,
  worker_leave_ledger_entries, hr_audit_events
Hash-16 allowlist: attendance_event_locators, attendance_correction_links,
  hr_audit_event_sources, worker_leave_entry_locators,
  worker_leave_reversal_links

Dry run:
  node --env-file=.env -r ts-node/register src/scripts/hrms-partition-planner/hrms-partitions.ts \\
    --environment=staging --tables=attendance_events --current-next-three

Apply:
  node --env-file=.env -r ts-node/register src/scripts/hrms-partition-planner/hrms-partitions.ts \\
    --apply --environment=staging --tables=attendance_events --months=2026-08 \\
    --manifest=partition-manifest.json --manifest-sha256=<sha256> \\
    --approval-id=<opaque-id> --application-role=<role> \\
    --migration-role=<role>

Hash families additionally require --hash-modulus=16.
Use --tenants=id1,id2 only for approval/backfill rollout scope;
partitions remain global and do not provide tenant-level physical isolation.
Production apply additionally requires --ack-production.
DIRECT_DATABASE_URL is required only for --apply.

Manifest JSON fields:
  version, approvalId, environment, database, databaseRole, applicationRole,
  migrationRole, tables, securityProfiles, months, tenantIds, hashModulus,
  expiresAt, baseBundleDependencies
`;

function loadManifest(
  options: PlannerOptions,
  now: Date,
): VerifiedPartitionManifest | null {
  if (options.manifestPath === null || options.manifestSha256 === null) return null;
  const path = resolve(process.cwd(), options.manifestPath);
  const raw = readFileSync(path, "utf8");
  return parseAndVerifyManifest(raw, options.manifestSha256, options, now);
}

function normalizeDatabaseUrl(url: string): string {
  if (!/\.neon\.tech/i.test(url)) return url;
  const parsed = new URL(url);
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

function reportResult(result: PartitionApplyResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function runApply(
  options: PlannerOptions,
  verified: VerifiedPartitionManifest,
): Promise<void> {
  const rawUrl = z.string().url().parse(process.env.DIRECT_DATABASE_URL);
  const client = createClient(normalizeDatabaseUrl(rawUrl));
  try {
    const identity = await readDatabaseIdentity(client);
    assertManifestDatabase(
      verified.manifest,
      identity.database,
      identity.databaseRole,
    );
    if (identity.configuredEnvironment === null)
      throw new Error("database must declare app.environment before apply");
    if (identity.configuredEnvironment !== options.environment)
      throw new Error(
        `database environment is ${identity.configuredEnvironment}, not ${options.environment}`,
      );
    await assertTenantAllowlist(client, options.tenantIds);
    const attendanceSecurityVerified = needsAttendanceSecurityVerification(
      options.tables,
    );
    const firstTable = options.tables[0];
    if (!firstTable) throw new Error("partition table scope is empty");
    const securityProfile = securityProfileForTable(
      verified.manifest,
      firstTable,
    );
    if (attendanceSecurityVerified)
      await assertAttendanceSecurityReady(
        client,
        securityProfile,
        verified.manifest.applicationRole,
        verified.manifest.migrationRole,
      );
    const plan = buildPartitionPlan(options);
    process.stdout.write(
      `${JSON.stringify({
        mode: "apply",
        status: "approval-validated",
        environment: options.environment,
        database: identity.database,
        databaseRole: identity.databaseRole,
        applicationRole: verified.manifest.applicationRole,
        migrationRole: verified.manifest.migrationRole,
        databaseIdentityVerified: true,
        approvalId: verified.manifest.approvalId,
        manifestSha256: verified.sha256,
        manifestExpiresAt: verified.manifest.expiresAt,
        approvedTables: options.tables,
        approvedMonths: options.months,
        approvedHashModulus: options.hashModulus,
        approvalTenantCount: options.tenantIds.length,
        partitionCount: plan.length,
        attendanceSecurityStatus: attendanceSecurityVerified
          ? "verified"
          : "not-applicable",
      })}\n`,
    );
    const results = await applyPartitionPlan(
      client,
      plan,
      verified,
      reportResult,
    );
    process.stdout.write(
      `${JSON.stringify({ mode: "apply", status: "complete", partitions: results.length })}\n`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const now = new Date();
  const parsed = parseCliOptions(process.argv.slice(2), now, process.env.NODE_ENV);
  if (parsed.kind === "help") {
    process.stdout.write(usage);
    return;
  }

  const verified = loadManifest(parsed.options, now);
  const plan = buildPartitionPlan(parsed.options);
  if (!parsed.options.apply) {
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: "dry-run",
          environment: parsed.options.environment,
          approvalTenantIds: parsed.options.tenantIds,
          approvalId: verified?.manifest.approvalId ?? null,
          applicationRole: verified?.manifest.applicationRole ?? null,
          migrationRole: verified?.manifest.migrationRole ?? null,
          manifestScopeVerified: verified !== null,
          databaseVerified: false,
          attendanceSecurityPreflightRequired:
            needsAttendanceSecurityVerification(parsed.options.tables),
          plan,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (verified === null) throw new Error("apply manifest is required");
  await runApply(parsed.options, verified);
}

void main().catch((error: unknown) => {
  const code = safePartitionFailureCode(error);
  process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
  process.exitCode = 1;
});
