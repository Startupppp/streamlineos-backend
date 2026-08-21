import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  deriveEd25519Key,
  leaveOpeningManifestSchema,
  sha256,
  type LeaveOpeningManifest,
} from "./backfill-manifest";

export const fixtureNow = new Date("2026-08-11T00:00:00.000Z");

export type BackfillTestFixture = {
  manifest: LeaveOpeningManifest;
  rawManifest: Buffer;
  manifestSha256: string;
  signature: string;
  publicKeyPem: string;
  privateKey: KeyObject;
  keyId: string;
};

export function encodeSignedManifest(
  value: unknown,
  privateKey: KeyObject,
): { rawManifest: Buffer; manifestSha256: string; signature: string } {
  const rawManifest = Buffer.from(JSON.stringify(value));
  return {
    rawManifest,
    manifestSha256: sha256(rawManifest),
    signature: sign(null, rawManifest, privateKey).toString("base64"),
  };
}

export function createBackfillTestFixture(): BackfillTestFixture {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  const { keyId } = deriveEd25519Key(publicKeyPem);
  const manifest = leaveOpeningManifestSchema.parse({
    version: "v1",
    kind: "hrms-leave-opening-backfill",
    environment: "production",
    database: "streamline_production",
    databaseRole: "streamline_hrms_migration",
    approvalReference: "APR_20260811_001",
    expiresAt: "2026-08-12T00:00:00.000Z",
    keyId,
    source: { rowCount: 5, totalBalance: "94.2000" },
    reviewers: [
      { reviewerId: "reviewer-owner-001", role: "ORG_DATA_OWNER" },
      {
        reviewerId: "reviewer-security-002",
        role: "INDEPENDENT_HR_SECURITY",
      },
    ],
    entries: [
      entry(1, "10.0000", "2025-01-15"),
      entry(2, "20.0000", "2025-02-15"),
      entry(3, "30.0000", "2026-01-15"),
      entry(4, "15.0000", "2026-01-16"),
      entry(5, "19.2000", "2026-02-15"),
    ],
  });
  return {
    manifest,
    ...encodeSignedManifest(manifest, privateKey),
    publicKeyPem,
    privateKey,
    keyId,
  };
}

function entry(
  sourceBalanceId: number,
  sourceBalance: string,
  effectiveDate: string,
): Record<string, string | number> {
  const sourceYear = Number(effectiveDate.slice(0, 4));
  return {
    sourceBalanceId,
    orgId: "org-001",
    sourceUserId: `user-${sourceBalanceId}`,
    sourceYear,
    sourceBalance,
    workerId: `worker-${sourceBalanceId}`,
    workerEngagementId: `engagement-${sourceBalanceId}`,
    leaveTypeId: sourceBalanceId,
    periodKey: String(sourceYear),
    effectiveDate,
  };
}
