import {
  buildOperationId,
  bundleFileNames,
  rootMigration,
} from "../hrms-schema-bundle/bundle-config";
import type { BaseBundleIdentity } from "./partition-dependencies";
import { partitionManifestSchema } from "./partition-manifest";
import {
  buildPartitionOperationIdentity,
  decidePartitionOperation,
  type PartitionOperationIdentity,
  type PartitionOperationRow,
} from "./partition-operation-identity";
import type { PartitionPlanItem } from "./partition-plan";

function verified() {
  const dependencies = bundleFileNames.map((fileName, index) => {
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
      databaseRole: "hrms_partition_owner",
    };
  });
  return {
    manifest: partitionManifestSchema.parse({
      version: 1,
      approvalId: "APR_20260811_001",
      environment: "production",
      database: "streamlineos",
      databaseRole: "hrms_partition_owner",
      applicationRole: "streamline_app",
      migrationRole: "streamline_hrms_migration",
      tables: ["attendance_events", "attendance_event_locators"],
      securityProfiles: [
        { table: "attendance_events", profile: "base-owner-only-v1" },
        {
          table: "attendance_event_locators",
          profile: "base-owner-only-v1",
        },
      ],
      months: ["2026-08"],
      tenantIds: [],
      hashModulus: 16,
      expiresAt: "2026-08-12T00:00:00Z",
      baseBundleDependencies: dependencies,
    }),
    sha256: "f".repeat(64),
  };
}

const base: BaseBundleIdentity = {
  logicalBundleId: "hrms-phase1@1",
  rootMigrationSha256: "b".repeat(64),
  databaseName: "streamlineos",
  databaseRole: "hrms_partition_owner",
  serverVersion: 170002,
  dependenciesSha256: "d".repeat(64),
};

const rangeItem: PartitionPlanItem = {
  kind: "range",
  parent: "attendance_events",
  child: "attendance_events_y2026m08",
  month: "2026-08",
  from: "2026-08-01",
  to: "2026-09-01",
};

function current(
  item: PartitionPlanItem = rangeItem,
): PartitionOperationIdentity {
  return buildPartitionOperationIdentity(
    item,
    verified(),
    base,
    "base-owner-only-v1",
  );
}

function row(
  identity: PartitionOperationIdentity,
  overrides: Partial<PartitionOperationRow> = {},
): PartitionOperationRow {
  return {
    operation_id: identity.operationId,
    approval_id: identity.approvalId,
    manifest_hash: identity.manifestHash,
    base_bundle_id: identity.baseBundleId,
    root_migration_name: identity.rootMigrationName,
    root_migration_hash: identity.rootMigrationHash,
    base_dependencies_hash: identity.baseDependenciesHash,
    database_name: identity.databaseName,
    database_role: identity.databaseRole,
    server_version_num: identity.serverVersion,
    parent_table: identity.parentTable,
    child_table: identity.childTable,
    partition_kind: identity.partitionKind,
    range_from: identity.rangeFrom,
    range_to: identity.rangeTo,
    hash_modulus: identity.hashModulus,
    hash_remainder: identity.hashRemainder,
    security_profile: identity.securityProfile,
    ddl_hash: identity.ddlHash,
    state: "COMPLETE",
    attempts: 1,
    ...overrides,
  };
}

describe("HRMS partition operation identity", () => {
  it("binds an exact range child and approved provenance", () => {
    expect(current()).toMatchObject({
      approvalId: "APR_20260811_001",
      manifestHash: "f".repeat(64),
      baseDependenciesHash: "d".repeat(64),
      databaseName: "streamlineos",
      databaseRole: "hrms_partition_owner",
      parentTable: "attendance_events",
      childTable: "attendance_events_y2026m08",
      partitionKind: "RANGE",
      rangeFrom: "2026-08-01",
      rangeTo: "2026-09-01",
      hashModulus: null,
      hashRemainder: null,
      securityProfile: "base-owner-only-v1",
    });
    expect(current().ddlHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds an exact fixed hash child", () => {
    const identity = current({
      kind: "hash",
      parent: "attendance_event_locators",
      child: "attendance_event_locators_h03",
      modulus: 16,
      remainder: 3,
    });
    expect(identity).toMatchObject({
      partitionKind: "HASH",
      rangeFrom: null,
      rangeTo: null,
      hashModulus: 16,
      hashRemainder: 3,
    });
  });

  it("supports only new, failed-resume, and completed decisions", () => {
    const identity = current();
    expect(decidePartitionOperation([], identity)).toBe("run");
    expect(
      decidePartitionOperation([row(identity, { state: "FAILED" })], identity),
    ).toBe("resume");
    expect(decidePartitionOperation([row(identity)], identity)).toBe("complete");
    expect(() =>
      decidePartitionOperation(
        [row(identity, { state: "VERIFYING" })],
        identity,
      ),
    ).toThrow("PARTITION_OPERATION_ACTIVE");
  });

  it.each([
    ["manifest_hash", "e".repeat(64)],
    ["base_dependencies_hash", "c".repeat(64)],
    ["database_role", "other_owner"],
    ["child_table", "attendance_events_y2026m09"],
    ["range_to", "2026-10-01"],
    ["ddl_hash", "a".repeat(64)],
  ] satisfies Array<[keyof PartitionOperationRow, string]>) (
    "rejects completed identity drift in %s",
    (field, value) => {
      const identity = current();
      expect(() =>
        decidePartitionOperation([row(identity, { [field]: value })], identity),
      ).toThrow("PARTITION_OPERATION_IDENTITY_MISMATCH");
    },
  );
});
