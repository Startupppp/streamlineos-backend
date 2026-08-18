import {
  buildOperationId,
  bundleFileNames,
  rootMigration,
} from "../hrms-schema-bundle/bundle-config";
import { assertBaseBundleDependencyRows } from "./partition-dependencies";
import { partitionManifestSchema } from "./partition-manifest";

const database = "streamlineos";
const databaseRole = "hrms_partition_owner";

function dependencies() {
  return bundleFileNames.map((fileName, index) => {
    const manifestSha256 = (index + 10).toString(16).repeat(64);
    return {
      operationId: buildOperationId(
        "hrms-phase1@1",
        fileName,
        manifestSha256,
      ),
      logicalBundleId: "hrms-phase1@1",
      rootMigrationName: rootMigration.name,
      rootMigrationSha256: "b".repeat(64),
      fileName,
      sqlSha256: (index + 1).toString(16).repeat(64),
      manifestSha256,
      databaseRole,
    };
  });
}

function verified() {
  return {
    manifest: partitionManifestSchema.parse({
      version: 1,
      approvalId: "APR_20260811_001",
      environment: "production",
      database,
      databaseRole,
      applicationRole: "streamline_app",
      migrationRole: "streamline_hrms_migration",
      tables: ["attendance_events"],
      securityProfiles: [
        { table: "attendance_events", profile: "base-owner-only-v1" },
      ],
      months: ["2026-08"],
      tenantIds: [],
      hashModulus: null,
      expiresAt: "2026-08-12T00:00:00Z",
      baseBundleDependencies: dependencies(),
    }),
    sha256: "f".repeat(64),
  };
}

function rows() {
  return verified().manifest.baseBundleDependencies.map((dependency) => ({
    operation_id: dependency.operationId,
    bundle_id: dependency.logicalBundleId,
    file_name: dependency.fileName,
    sql_hash: dependency.sqlSha256,
    manifest_hash: dependency.manifestSha256,
    root_migration_hash: dependency.rootMigrationSha256,
    state: "COMPLETE",
    database_name: database,
    database_role: databaseRole,
    server_version_num: 170002,
    current_database_name: database,
    current_database_role: databaseRole,
    current_server_version: 170002,
  }));
}

describe("HRMS partition base dependencies", () => {
  it("accepts five exact completed operations from renewed approvals", () => {
    const identity = assertBaseBundleDependencyRows(rows(), verified());
    expect(identity).toMatchObject({
      logicalBundleId: "hrms-phase1@1",
      rootMigrationSha256: "b".repeat(64),
      databaseName: database,
      databaseRole,
      serverVersion: 170002,
    });
    expect(identity.dependenciesSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a missing base operation", () => {
    expect(() =>
      assertBaseBundleDependencyRows(rows().slice(0, 4), verified()),
    ).toThrow("PARTITION_BASE_DEPENDENCY_COUNT_MISMATCH");
  });

  it.each([
    ["state", "FAILED"],
    ["sql_hash", "e".repeat(64)],
    ["manifest_hash", "9".repeat(64)],
    ["root_migration_hash", "8".repeat(64)],
    ["database_name", "other_database"],
    ["database_role", "other_role"],
    ["current_database_name", "other_database"],
    ["current_database_role", "other_role"],
  ])("rejects dependency identity drift in %s", (field, value) => {
    const changed = rows();
    changed[2] = { ...changed[2], [field]: value };
    expect(() =>
      assertBaseBundleDependencyRows(changed, verified()),
    ).toThrow("PARTITION_BASE_DEPENDENCY_IDENTITY_MISMATCH");
  });

  it("rejects base operations recorded on another server version", () => {
    const changed = rows();
    changed[1] = { ...changed[1], server_version_num: 160009 };
    expect(() =>
      assertBaseBundleDependencyRows(changed, verified()),
    ).toThrow("PARTITION_BASE_DEPENDENCY_IDENTITY_MISMATCH");
  });
});
