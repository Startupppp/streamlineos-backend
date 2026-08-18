import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  bundleEnvironmentSchema,
  hashSchema,
  rootMigration,
} from "./bundle-config";
import { fail } from "./bundle-error";
import type { BundleSnapshot } from "./bundle-files";

const identifierSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
const bundleTokenSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const approvalTokenSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_:-]*$/);
const fileSchema = (name: string) =>
  z.object({ name: z.literal(name), sha256: hashSchema }).strict();

export const bundleManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    bundleId: bundleTokenSchema,
    bundleVersion: bundleTokenSchema,
    environment: bundleEnvironmentSchema,
    database: identifierSchema,
    databaseRole: identifierSchema,
    applicationRole: identifierSchema,
    migrationRole: identifierSchema,
    rootMigration: z
      .object({
        name: z.literal(rootMigration.name),
        sha256: hashSchema,
      })
      .strict(),
    serverVersion: z
      .object({
        min: z.number().int().min(100000).max(999999),
        max: z.number().int().min(100000).max(999999),
      })
      .strict(),
    approvalId: approvalTokenSchema,
    expiresAt: z.string().datetime({ offset: true }),
    files: z.tuple([
      fileSchema("0000_hrms_profiles_workforce.sql"),
      fileSchema("0001_hrms_effective_history.sql"),
      fileSchema("0002_hrms_leave_ledger.sql"),
      fileSchema("0003_hrms_attendance_events.sql"),
      fileSchema("0004_hrms_hierarchy_audit.sql"),
    ]),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.serverVersion.min > manifest.serverVersion.max)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["serverVersion"],
        message: "server version range is inverted",
      });
    const roles = [
      manifest.databaseRole,
      manifest.applicationRole,
      manifest.migrationRole,
    ];
    if (new Set(roles).size !== roles.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applicationRole"],
        message: "database roles must be distinct",
      });
  });

export type BundleManifest = z.infer<typeof bundleManifestSchema>;

export type VerifiedManifest = {
  manifest: BundleManifest;
  sha256: string;
};

export function assertManifestNotExpired(
  manifest: BundleManifest,
  now: Date,
): void {
  const expiresAt = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime())
    fail("RUNNER_MANIFEST_EXPIRED");
}

function assertSnapshotHashes(
  manifest: BundleManifest,
  snapshot: BundleSnapshot,
): void {
  if (
    manifest.rootMigration.name !== snapshot.root.name ||
    manifest.rootMigration.sha256 !== snapshot.root.sha256
  )
    fail("RUNNER_ROOT_MIGRATION_MISMATCH");
  if (manifest.files.length !== snapshot.files.length)
    fail("RUNNER_FILE_ALLOWLIST_MISMATCH");
  for (const [index, file] of snapshot.files.entries()) {
    const approved = manifest.files[index];
    if (approved?.name !== file.name || approved.sha256 !== file.sha256)
      fail("RUNNER_FILE_HASH_MISMATCH");
  }
}

export function parseAndVerifyBundleManifest(
  rawManifest: string,
  expectedSha256: string,
  snapshot: BundleSnapshot,
  now: Date,
): VerifiedManifest {
  const actualSha256 = createHash("sha256")
    .update(rawManifest)
    .digest("hex");
  if (actualSha256 !== expectedSha256.toLowerCase())
    fail("RUNNER_MANIFEST_HASH_MISMATCH");
  const parsedJson: unknown = JSON.parse(rawManifest);
  const parsed = bundleManifestSchema.safeParse(parsedJson);
  if (!parsed.success) fail("RUNNER_MANIFEST_INVALID");
  assertManifestNotExpired(parsed.data, now);
  assertSnapshotHashes(parsed.data, snapshot);
  return { manifest: parsed.data, sha256: actualSha256 };
}

export function loadAndVerifyBundleManifest(
  manifestPath: string,
  expectedSha256: string,
  snapshot: BundleSnapshot,
  now: Date,
): VerifiedManifest {
  let raw: Buffer;
  try {
    raw = readFileSync(resolve(process.cwd(), manifestPath));
  } catch {
    fail("RUNNER_MANIFEST_UNREADABLE");
  }
  if (raw.byteLength > 64 * 1024) fail("RUNNER_MANIFEST_TOO_LARGE");
  return parseAndVerifyBundleManifest(
    raw.toString(),
    expectedSha256,
    snapshot,
    now,
  );
}

export function assertApplyApproval(
  manifest: BundleManifest,
  acknowledgeProduction: boolean,
  nodeEnvironment: string | undefined,
): void {
  if (manifest.environment === "production" && !acknowledgeProduction)
    fail("RUNNER_PRODUCTION_ACK_REQUIRED");
  if (manifest.environment !== "production" && acknowledgeProduction)
    fail("RUNNER_PRODUCTION_ACK_UNEXPECTED");
  if (nodeEnvironment === "production" && manifest.environment !== "production")
    fail("RUNNER_NODE_ENVIRONMENT_MISMATCH");
}
