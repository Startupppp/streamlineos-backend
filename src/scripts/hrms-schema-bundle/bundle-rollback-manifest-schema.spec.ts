import {
  buildLogicalBundleId,
  buildOperationId,
} from "./bundle-config";
import type { BundleSnapshot } from "./bundle-files";
import { sha256 } from "./bundle-files";
import { parseAndVerifyRollbackManifest } from "./bundle-rollback-manifest-schema";

const now = new Date("2026-08-11T00:00:00Z");
const snapshot: BundleSnapshot = {
  root: {
    name: "0398_backfill_hr_admin_branch_hr_recruitment_grants.sql",
    createdAt: 1785775600000,
    sha256: "a".repeat(64),
  },
  files: [
    { name: "0000_hrms_profiles_workforce.sql", sql: "zero", sha256: "b".repeat(64) },
    { name: "0001_hrms_effective_history.sql", sql: "one", sha256: "c".repeat(64) },
    { name: "0002_hrms_leave_ledger.sql", sql: "two", sha256: "d".repeat(64) },
    { name: "0003_hrms_attendance_events.sql", sql: "three", sha256: "e".repeat(64) },
    { name: "0004_hrms_hierarchy_audit.sql", sql: "four", sha256: "f".repeat(64) },
  ],
  downFiles: [
    { name: "0000_hrms_profiles_workforce.down.sql", sql: "down-zero", sha256: "1".repeat(64) },
    { name: "0001_hrms_effective_history.down.sql", sql: "down-one", sha256: "2".repeat(64) },
    { name: "0002_hrms_leave_ledger.down.sql", sql: "down-two", sha256: "3".repeat(64) },
    { name: "0003_hrms_attendance_events.down.sql", sql: "down-three", sha256: "4".repeat(64) },
    { name: "0004_hrms_hierarchy_audit.down.sql", sql: "down-four", sha256: "5".repeat(64) },
  ],
};

function validManifest() {
  const logicalBundleId = buildLogicalBundleId("hrms-phase1", "1");
  const appliedOperations = snapshot.files.slice(0, 4).map((file, index) => {
    const applyManifestHash = String(index + 6).repeat(64);
    return {
      operationId: buildOperationId(
        logicalBundleId,
        file.name,
        applyManifestHash,
      ),
      bundleId: logicalBundleId,
      fileName: file.name,
      sqlHash: file.sha256,
      applyManifestHash,
      rootMigrationHash: snapshot.root.sha256,
      databaseName: "streamline_staging",
      databaseRole: "schema_owner",
      serverVersionNum: 160003,
    };
  });
  return {
    manifestVersion: 1,
    action: "rollback",
    bundleId: "hrms-phase1",
    bundleVersion: "1",
    environment: "staging",
    database: "streamline_staging",
    databaseRole: "schema_owner",
    applicationRole: "streamline_app",
    migrationRole: "streamline_hrms_migration",
    rootMigration: { name: snapshot.root.name, sha256: snapshot.root.sha256 },
    serverVersion: { min: 150000, max: 170999 },
    approvalId: "RBK_20260811_001",
    expiresAt: "2026-08-12T00:00:00Z",
    rollbackThrough: "0002_hrms_leave_ledger.sql",
    files: snapshot.files.map((file) => ({
      name: file.name,
      sha256: file.sha256,
    })),
    downFiles: snapshot.downFiles.map((file) => ({
      name: file.name,
      sha256: file.sha256,
    })),
    appliedOperations,
  };
}

function parse(manifest: object): void {
  const raw = JSON.stringify(manifest);
  parseAndVerifyRollbackManifest(raw, sha256(raw), snapshot, now);
}

describe("HRMS schema bundle rollback manifest", () => {
  it("binds renewed per-file apply identities and exact down hashes", () => {
    expect(() => parse(validManifest())).not.toThrow();
  });

  it("rejects down-file hash drift", () => {
    const manifest = validManifest();
    const downFiles = snapshot.downFiles.map((file) => ({
      name: file.name,
      sha256: file.sha256,
    }));
    const last = downFiles[4];
    if (!last) throw new Error("test down file missing");
    last.sha256 = "9".repeat(64);
    expect(() => parse({ ...manifest, downFiles })).toThrow(
      "RUNNER_ROLLBACK_FILE_HASH_MISMATCH",
    );
  });

  it("rejects a non-prefix or mismatched applied identity", () => {
    const manifest = validManifest();
    const altered = manifest.appliedOperations.map(
      (operation) => ({ ...operation }),
    );
    const second = altered[1];
    if (!second) throw new Error("test operation missing");
    second.fileName = "0002_hrms_leave_ledger.sql";
    expect(() => parse({ ...manifest, appliedOperations: altered })).toThrow(
      "RUNNER_ROLLBACK_MANIFEST_INVALID",
    );
  });

  it("rejects a rollback endpoint beyond the bound prefix", () => {
    expect(() =>
      parse({
        ...validManifest(),
        rollbackThrough: "0004_hrms_hierarchy_audit.sql",
      }),
    ).toThrow("RUNNER_ROLLBACK_MANIFEST_INVALID");
  });
});
