import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  bundleEnvironmentSchema,
  bundleFileNames,
  bundleFileNameSchema,
  buildLogicalBundleId,
  buildOperationId,
  hashSchema,
  rootMigration,
} from "./bundle-config";
import { fail } from "./bundle-error";
import type { BundleSnapshot } from "./bundle-files";
import { assertManifestNotExpired } from "./bundle-manifest-schema";

const identifierSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
const tokenSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const approvalSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_:-]*$/);
const fileSchema = (name: string) =>
  z.object({ name: z.literal(name), sha256: hashSchema }).strict();
const operationSchema = z.object({
  operationId: z.string().min(3).max(512)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/),
  bundleId: z.string().min(3).max(129)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/),
  fileName: bundleFileNameSchema,
  sqlHash: hashSchema,
  applyManifestHash: hashSchema,
  rootMigrationHash: hashSchema,
  databaseName: identifierSchema,
  databaseRole: identifierSchema,
  serverVersionNum: z.number().int().positive(),
}).strict();

export const bundleRollbackManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    action: z.literal("rollback"),
    bundleId: tokenSchema,
    bundleVersion: tokenSchema,
    environment: bundleEnvironmentSchema,
    database: identifierSchema,
    databaseRole: identifierSchema,
    applicationRole: identifierSchema,
    migrationRole: identifierSchema,
    rootMigration: z.object({
      name: z.literal(rootMigration.name),
      sha256: hashSchema,
    }).strict(),
    serverVersion: z.object({
      min: z.number().int().min(100000).max(999999),
      max: z.number().int().min(100000).max(999999),
    }).strict(),
    approvalId: approvalSchema,
    expiresAt: z.string().datetime({ offset: true }),
    rollbackThrough: bundleFileNameSchema,
    files: z.tuple([
      fileSchema("0000_hrms_profiles_workforce.sql"),
      fileSchema("0001_hrms_effective_history.sql"),
      fileSchema("0002_hrms_leave_ledger.sql"),
      fileSchema("0003_hrms_attendance_events.sql"),
      fileSchema("0004_hrms_hierarchy_audit.sql"),
    ]),
    downFiles: z.tuple([
      fileSchema("0000_hrms_profiles_workforce.down.sql"),
      fileSchema("0001_hrms_effective_history.down.sql"),
      fileSchema("0002_hrms_leave_ledger.down.sql"),
      fileSchema("0003_hrms_attendance_events.down.sql"),
      fileSchema("0004_hrms_hierarchy_audit.down.sql"),
    ]),
    appliedOperations: z.array(operationSchema).min(1).max(5),
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
    const logicalBundleId = buildLogicalBundleId(
      manifest.bundleId,
      manifest.bundleVersion,
    );
    for (const [index, operation] of manifest.appliedOperations.entries()) {
      const fileName = bundleFileNames[index];
      const approvedFile = manifest.files[index];
      if (
        !fileName ||
        !approvedFile ||
        operation.fileName !== fileName ||
        operation.bundleId !== logicalBundleId ||
        operation.operationId !== buildOperationId(
          logicalBundleId,
          fileName,
          operation.applyManifestHash,
        ) ||
        operation.sqlHash !== approvedFile.sha256 ||
        operation.rootMigrationHash !== manifest.rootMigration.sha256 ||
        operation.databaseName !== manifest.database ||
        operation.databaseRole !== manifest.databaseRole ||
        operation.serverVersionNum < manifest.serverVersion.min ||
        operation.serverVersionNum > manifest.serverVersion.max
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["appliedOperations", index],
          message: "applied operation identity does not match approval",
        });
    }
    const throughIndex = bundleFileNames.indexOf(manifest.rollbackThrough);
    if (throughIndex >= manifest.appliedOperations.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rollbackThrough"],
        message: "rollback endpoint is outside the applied prefix",
      });
  });

export type BundleRollbackManifest = z.infer<
  typeof bundleRollbackManifestSchema
>;

export type VerifiedRollbackManifest = {
  manifest: BundleRollbackManifest;
  sha256: string;
};

function assertSnapshotHashes(
  manifest: BundleRollbackManifest,
  snapshot: BundleSnapshot,
): void {
  if (
    manifest.rootMigration.name !== snapshot.root.name ||
    manifest.rootMigration.sha256 !== snapshot.root.sha256
  )
    fail("RUNNER_ROOT_MIGRATION_MISMATCH");
  for (const [index, file] of snapshot.files.entries()) {
    const approved = manifest.files[index];
    if (approved?.name !== file.name || approved.sha256 !== file.sha256)
      fail("RUNNER_FILE_HASH_MISMATCH");
  }
  for (const [index, file] of snapshot.downFiles.entries()) {
    const approved = manifest.downFiles[index];
    if (approved?.name !== file.name || approved.sha256 !== file.sha256)
      fail("RUNNER_ROLLBACK_FILE_HASH_MISMATCH");
  }
}

export function parseAndVerifyRollbackManifest(
  rawManifest: string,
  expectedSha256: string,
  snapshot: BundleSnapshot,
  now: Date,
): VerifiedRollbackManifest {
  const actualSha256 = createHash("sha256").update(rawManifest).digest("hex");
  if (actualSha256 !== expectedSha256.toLowerCase())
    fail("RUNNER_MANIFEST_HASH_MISMATCH");
  const parsedJson: unknown = JSON.parse(rawManifest);
  const parsed = bundleRollbackManifestSchema.safeParse(parsedJson);
  if (!parsed.success) fail("RUNNER_ROLLBACK_MANIFEST_INVALID");
  assertManifestNotExpired(parsed.data, now);
  assertSnapshotHashes(parsed.data, snapshot);
  return { manifest: parsed.data, sha256: actualSha256 };
}

export function loadAndVerifyRollbackManifest(
  manifestPath: string,
  expectedSha256: string,
  snapshot: BundleSnapshot,
  now: Date,
): VerifiedRollbackManifest {
  let raw: Buffer;
  try {
    raw = readFileSync(resolve(process.cwd(), manifestPath));
  } catch {
    fail("RUNNER_MANIFEST_UNREADABLE");
  }
  if (raw.byteLength > 64 * 1024) fail("RUNNER_MANIFEST_TOO_LARGE");
  return parseAndVerifyRollbackManifest(
    raw.toString(),
    expectedSha256,
    snapshot,
    now,
  );
}
