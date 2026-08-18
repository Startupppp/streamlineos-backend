import {
  sha256,
  type VerifiedLeaveOpeningManifest,
} from "./backfill-manifest";

type DryRunOperation = {
  sourceBalanceId: number;
  organizationId: string;
  sourceUserId: string;
  workerId: string;
  workerEngagementId: string;
  leaveTypeId: number;
  periodKey: string;
  requiredPartitionMonth: string;
  operationKey: string;
  commandKey: string;
  sourceKey: string;
};

export type LeaveOpeningDryRunReport = {
  mode: "dry-run";
  status: "verified";
  databaseAccessed: false;
  applyAvailable: false;
  versionId: "v1";
  kindId: "hrms-leave-opening-backfill";
  environmentId: string;
  databaseId: string;
  databaseRoleId: string;
  approvalReferenceId: string;
  keyId: string;
  manifestSha256: string;
  publicKeySha256: string;
  sourceBaselineSha256: string;
  sourceRowCount: 5;
  reviewerIds: string[];
  reviewerRoleIds: string[];
  organizationIds: string[];
  sourceUserIds: string[];
  workerIds: string[];
  workerEngagementIds: string[];
  leaveTypeIds: number[];
  sourceBalanceIds: number[];
  requiredPartitionMonths: string[];
  operationCount: number;
  operations: DryRunOperation[];
};

function uniqueText(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function operationHash(
  verified: VerifiedLeaveOpeningManifest,
  index: number,
): string {
  const entry = verified.manifest.entries[index];
  if (!entry) throw new Error("LEAVE_OPENING_ENTRY_MISSING");
  return sha256(
    [
      "v1",
      verified.manifestSha256,
      entry.sourceBalanceId,
      entry.orgId,
      entry.sourceUserId,
      entry.sourceYear,
      entry.sourceBalance,
      entry.workerId,
      entry.workerEngagementId,
      entry.leaveTypeId,
      entry.periodKey,
      entry.effectiveDate,
    ].join("\u0000"),
  );
}

export function buildLeaveOpeningDryRunReport(
  verified: VerifiedLeaveOpeningManifest,
): LeaveOpeningDryRunReport {
  const manifest = verified.manifest;
  const entries = manifest.entries
    .map((entry, index) => ({ entry, operationKey: operationHash(verified, index) }))
    .sort((left, right) =>
      left.entry.sourceBalanceId - right.entry.sourceBalanceId,
    );
  const operations = entries.map(({ entry, operationKey }) => {
    const commandId = `${verified.manifestSha256}:${entry.sourceBalanceId}`;
    return {
      sourceBalanceId: entry.sourceBalanceId,
      organizationId: entry.orgId,
      sourceUserId: entry.sourceUserId,
      workerId: entry.workerId,
      workerEngagementId: entry.workerEngagementId,
      leaveTypeId: entry.leaveTypeId,
      periodKey: entry.periodKey,
      requiredPartitionMonth: entry.effectiveDate.slice(0, 7),
      operationKey,
      commandKey: `HRMS_LEAVE_OPENING_BALANCE:${commandId}:0`,
      sourceKey: `LEGACY_LEAVE_BALANCE:${entry.sourceBalanceId}:0`,
    };
  });
  return {
    mode: "dry-run",
    status: "verified",
    databaseAccessed: false,
    applyAvailable: false,
    versionId: manifest.version,
    kindId: manifest.kind,
    environmentId: manifest.environment,
    databaseId: manifest.database,
    databaseRoleId: manifest.databaseRole,
    approvalReferenceId: manifest.approvalReference,
    keyId: manifest.keyId,
    manifestSha256: verified.manifestSha256,
    publicKeySha256: verified.publicKeySha256,
    sourceBaselineSha256: sha256(JSON.stringify(manifest.source)),
    sourceRowCount: manifest.source.rowCount,
    reviewerIds: uniqueText(manifest.reviewers.map((item) => item.reviewerId)),
    reviewerRoleIds: uniqueText(manifest.reviewers.map((item) => item.role)),
    organizationIds: uniqueText(manifest.entries.map((item) => item.orgId)),
    sourceUserIds: uniqueText(manifest.entries.map((item) => item.sourceUserId)),
    workerIds: uniqueText(manifest.entries.map((item) => item.workerId)),
    workerEngagementIds: uniqueText(
      manifest.entries.map((item) => item.workerEngagementId),
    ),
    leaveTypeIds: uniqueNumbers(manifest.entries.map((item) => item.leaveTypeId)),
    sourceBalanceIds: uniqueNumbers(
      manifest.entries.map((item) => item.sourceBalanceId),
    ),
    requiredPartitionMonths: uniqueText(
      manifest.entries.map((item) => item.effectiveDate.slice(0, 7)),
    ),
    operationCount: operations.length,
    operations,
  };
}
