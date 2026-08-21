import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { fail } from "./backfill-error";
import type { BackfillOptions } from "./backfill-options";

const tokenSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);
const databaseIdentifierSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
const keyIdSchema = z
  .string()
  .regex(/^ed25519-sha256:[a-f0-9]{64}$/);
const balanceSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,6})\.[0-9]{4}$/)
  .refine((value) => decimalUnits(value) > 0n);
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarDate);
const reviewerRoleSchema = z.enum([
  "ORG_DATA_OWNER",
  "INDEPENDENT_HR_SECURITY",
]);

const reviewerSchema = z
  .object({ reviewerId: tokenSchema, role: reviewerRoleSchema })
  .strict();

const entrySchema = z
  .object({
    sourceBalanceId: z.number().int().positive().max(2_147_483_647),
    orgId: tokenSchema,
    sourceUserId: tokenSchema,
    sourceYear: z.number().int().min(1900).max(2200),
    sourceBalance: balanceSchema,
    workerId: tokenSchema,
    workerEngagementId: tokenSchema,
    leaveTypeId: z.number().int().positive().max(2_147_483_647),
    periodKey: tokenSchema,
    effectiveDate: dateSchema,
  })
  .strict();

export const leaveOpeningManifestSchema = z
  .object({
    version: z.literal("v1"),
    kind: z.literal("hrms-leave-opening-backfill"),
    environment: z.enum(["development", "staging", "production"]),
    database: databaseIdentifierSchema,
    databaseRole: databaseIdentifierSchema,
    approvalReference: tokenSchema,
    expiresAt: z.string().datetime({ offset: true }),
    keyId: keyIdSchema,
    source: z
      .object({
        rowCount: z.literal(5),
        totalBalance: z.literal("94.2000"),
      })
      .strict(),
    reviewers: z.array(reviewerSchema).length(2),
    entries: z.array(entrySchema).length(5),
  })
  .strict()
  .superRefine((manifest, context) => {
    const reviewerIds = manifest.reviewers.map((item) => item.reviewerId);
    const reviewerRoles = manifest.reviewers.map((item) => item.role);
    if (new Set(reviewerIds).size !== 2)
      addIssue(context, ["reviewers"], "reviewer IDs must be distinct");
    if (
      new Set(reviewerRoles).size !== 2 ||
      !reviewerRoles.includes("ORG_DATA_OWNER") ||
      !reviewerRoles.includes("INDEPENDENT_HR_SECURITY")
    )
      addIssue(context, ["reviewers"], "both reviewer roles are required");

    const sourceIds = manifest.entries.map((item) => item.sourceBalanceId);
    if (new Set(sourceIds).size !== manifest.entries.length)
      addIssue(context, ["entries"], "source balance IDs must be unique");
    const sourceKeys = manifest.entries.map((item) =>
      [item.orgId, item.sourceUserId, item.leaveTypeId, item.sourceYear].join("\u0000"),
    );
    if (new Set(sourceKeys).size !== manifest.entries.length)
      addIssue(context, ["entries"], "legacy source keys must be unique");
    const total = manifest.entries.reduce(
      (sum, item) => sum + decimalUnits(item.sourceBalance),
      0n,
    );
    if (total !== 942_000n)
      addIssue(context, ["entries"], "entry balances must total 94.2000");
  });

export type LeaveOpeningManifest = z.infer<typeof leaveOpeningManifestSchema>;

export type VerifiedLeaveOpeningManifest = {
  manifest: LeaveOpeningManifest;
  manifestSha256: string;
  publicKeySha256: string;
};

function addIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function decimalUnits(value: string): bigint {
  return BigInt(value.replace(".", ""));
}

function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function deriveEd25519Key(
  publicKeyPem: string,
): { key: KeyObject; keyId: string; publicKeySha256: string } {
  const normalized = publicKeyPem.trim();
  if (
    !normalized.startsWith("-----BEGIN PUBLIC KEY-----") ||
    !normalized.endsWith("-----END PUBLIC KEY-----") ||
    normalized.includes("PRIVATE KEY")
  )
    fail("LEAVE_OPENING_PUBLIC_KEY_INVALID");
  let key: KeyObject;
  try {
    key = createPublicKey(normalized);
  } catch {
    fail("LEAVE_OPENING_PUBLIC_KEY_INVALID");
  }
  if (key.asymmetricKeyType !== "ed25519")
    fail("LEAVE_OPENING_PUBLIC_KEY_NOT_ED25519");
  const der = key.export({ format: "der", type: "spki" });
  const publicKeySha256 = sha256(der);
  return {
    key,
    keyId: `ed25519-sha256:${publicKeySha256}`,
    publicKeySha256,
  };
}

function decodeSignature(encoded: string): Buffer {
  const normalized = encoded.trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(normalized))
    fail("LEAVE_OPENING_SIGNATURE_INVALID");
  const signature = Buffer.from(normalized, "base64");
  if (
    signature.byteLength !== 64 ||
    signature.toString("base64") !== normalized
  )
    fail("LEAVE_OPENING_SIGNATURE_INVALID");
  return signature;
}

function parseManifest(rawManifest: Buffer): LeaveOpeningManifest {
  let input: unknown;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(rawManifest);
    input = JSON.parse(decoded);
  } catch {
    fail("LEAVE_OPENING_MANIFEST_INVALID");
  }
  const parsed = leaveOpeningManifestSchema.safeParse(input);
  if (!parsed.success) fail("LEAVE_OPENING_MANIFEST_INVALID");
  return parsed.data;
}

export function verifyLeaveOpeningManifest(
  rawManifest: Buffer,
  expectedSha256: string,
  detachedSignature: string,
  publicKeyPem: string,
  expectedKeyId: string,
  now: Date,
): VerifiedLeaveOpeningManifest {
  const manifestSha256 = sha256(rawManifest);
  if (manifestSha256 !== expectedSha256.toLowerCase())
    fail("LEAVE_OPENING_MANIFEST_HASH_MISMATCH");
  const manifest = parseManifest(rawManifest);
  if (Date.parse(manifest.expiresAt) <= now.getTime())
    fail("LEAVE_OPENING_MANIFEST_EXPIRED");
  const key = deriveEd25519Key(publicKeyPem);
  if (manifest.keyId !== expectedKeyId || key.keyId !== expectedKeyId)
    fail("LEAVE_OPENING_KEY_ID_MISMATCH");
  const signature = decodeSignature(detachedSignature);
  if (!verify(null, rawManifest, key.key, signature))
    fail("LEAVE_OPENING_SIGNATURE_MISMATCH");
  return { manifest, manifestSha256, publicKeySha256: key.publicKeySha256 };
}

function readBounded(path: string, maxBytes: number, code: string): Buffer {
  let value: Buffer;
  try {
    value = readFileSync(resolve(process.cwd(), path));
  } catch {
    fail(code);
  }
  if (value.byteLength > maxBytes) fail(code);
  return value;
}

export function loadAndVerifyLeaveOpeningManifest(
  options: BackfillOptions,
  now: Date,
): VerifiedLeaveOpeningManifest {
  const rawManifest = readBounded(
    options.manifestPath,
    64 * 1024,
    "LEAVE_OPENING_MANIFEST_UNREADABLE",
  );
  const signature = readBounded(
    options.signaturePath,
    4096,
    "LEAVE_OPENING_SIGNATURE_UNREADABLE",
  ).toString("utf8");
  const publicKeyPem = readBounded(
    options.publicKeyPath,
    16 * 1024,
    "LEAVE_OPENING_PUBLIC_KEY_UNREADABLE",
  ).toString("utf8");
  return verifyLeaveOpeningManifest(
    rawManifest,
    options.manifestSha256,
    signature,
    publicKeyPem,
    options.keyId,
    now,
  );
}
