import type { BundleSnapshot } from "./bundle-files";
import { sha256 } from "./bundle-files";
import {
  assertApplyApproval,
  parseAndVerifyBundleManifest,
} from "./bundle-manifest-schema";

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

function validManifest(): object {
  return {
    manifestVersion: 1,
    bundleId: "hrms-phase1",
    bundleVersion: "1",
    environment: "staging",
    database: "streamline_staging",
    databaseRole: "schema_owner",
    applicationRole: "streamline_app",
    migrationRole: "streamline_hrms_migration",
    rootMigration: { name: snapshot.root.name, sha256: snapshot.root.sha256 },
    serverVersion: { min: 150000, max: 170999 },
    approvalId: "APR_20260811_001",
    expiresAt: "2026-08-12T00:00:00Z",
    files: snapshot.files.map((file) => ({
      name: file.name,
      sha256: file.sha256,
    })),
  };
}

function parse(manifest: object): ReturnType<typeof parseAndVerifyBundleManifest> {
  const raw = JSON.stringify(manifest);
  return parseAndVerifyBundleManifest(raw, sha256(raw), snapshot, now);
}

describe("HRMS schema bundle manifest", () => {
  it("binds the exact root and ordered SQL files", () => {
    const verified = parse(validManifest());
    expect(verified.manifest.bundleId).toBe("hrms-phase1");
    expect(verified.manifest.files.map((file) => file.name)).toEqual(
      snapshot.files.map((file) => file.name),
    );
  });

  it("rejects an unknown strict field", () => {
    expect(() => parse({ ...validManifest(), operatorEmail: "x@example.com" }))
      .toThrow("RUNNER_MANIFEST_INVALID");
  });

  it("rejects a missing or unsupported manifest version", () => {
    const manifest = validManifest();
    expect(() => parse({ ...manifest, manifestVersion: undefined })).toThrow(
      "RUNNER_MANIFEST_INVALID",
    );
    expect(() => parse({ ...manifest, manifestVersion: 2 })).toThrow(
      "RUNNER_MANIFEST_INVALID",
    );
  });

  it("rejects reused execution roles", () => {
    const manifest = validManifest();
    expect(() =>
      parse({ ...manifest, applicationRole: "schema_owner" }),
    ).toThrow("RUNNER_MANIFEST_INVALID");
  });

  it("rejects a reordered file list", () => {
    const manifest = validManifest();
    const files = snapshot.files.map((file) => ({
      name: file.name,
      sha256: file.sha256,
    }));
    files.reverse();
    expect(() => parse({ ...manifest, files })).toThrow(
      "RUNNER_MANIFEST_INVALID",
    );
  });

  it("rejects an expired approval", () => {
    expect(() =>
      parse({ ...validManifest(), expiresAt: "2026-08-10T00:00:00Z" }),
    ).toThrow("RUNNER_MANIFEST_EXPIRED");
  });

  it("requires a separate production acknowledgement", () => {
    const verified = parse({
      ...validManifest(),
      environment: "production",
    });
    expect(() =>
      assertApplyApproval(verified.manifest, false, "production"),
    ).toThrow("RUNNER_PRODUCTION_ACK_REQUIRED");
  });
});
