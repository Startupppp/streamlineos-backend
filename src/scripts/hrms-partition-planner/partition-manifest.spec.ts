import { createHash } from "node:crypto";
import {
  assertManifestDatabase,
  parseAndVerifyManifest,
} from "./partition-manifest";
import type { PlannerOptions } from "./partition-options";
import {
  buildOperationId,
  bundleFileNames,
  rootMigration,
} from "../hrms-schema-bundle/bundle-config";

const now = new Date("2026-08-11T00:00:00Z");

function plannerOptions(): PlannerOptions {
  return {
    apply: true,
    environment: "production",
    tables: ["attendance_events", "attendance_event_locators"],
    months: ["2026-08"],
    tenantIds: ["org-a"],
    hashModulus: 16,
    manifestPath: "approved.json",
    manifestSha256: "unused",
    approvalId: "APR_20260811_001",
    applicationRole: "streamline_app",
    migrationRole: "streamline_hrms_migration",
  };
}

function dependencies(): object[] {
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
      databaseRole: "hrms_partition_owner",
    };
  });
}

function manifestJson(): string {
  return JSON.stringify({
    version: 1,
    approvalId: "APR_20260811_001",
    environment: "production",
    database: "streamlineos",
    databaseRole: "hrms_partition_owner",
    applicationRole: "streamline_app",
    migrationRole: "streamline_hrms_migration",
    tables: [
      "attendance_events",
      "attendance_event_locators",
    ],
    securityProfiles: [
      { table: "attendance_events", profile: "base-owner-only-v1" },
      {
        table: "attendance_event_locators",
        profile: "base-owner-only-v1",
      },
    ],
    months: ["2026-08"],
    tenantIds: ["org-a"],
    hashModulus: 16,
    expiresAt: "2026-08-12T00:00:00Z",
    baseBundleDependencies: dependencies(),
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("HRMS partition approval manifest", () => {
  it("binds apply scope to file hash, database, role, and allowlists", () => {
    const raw = manifestJson();
    const verified = parseAndVerifyManifest(
      raw,
      digest(raw),
      plannerOptions(),
      now,
    );
    expect(() =>
      assertManifestDatabase(
        verified.manifest,
        "streamlineos",
        "hrms_partition_owner",
      ),
    ).not.toThrow();
  });

  it("rejects a modified manifest", () => {
    const raw = manifestJson();
    expect(() =>
      parseAndVerifyManifest(raw, "a".repeat(64), plannerOptions(), now),
    ).toThrow("PARTITION_MANIFEST_HASH_MISMATCH");
  });

  it("rejects scope outside the approved month allowlist", () => {
    const raw = manifestJson();
    const options = plannerOptions();
    options.months = ["2026-10"];
    expect(() =>
      parseAndVerifyManifest(raw, digest(raw), options, now),
    ).toThrow("PARTITION_MANIFEST_MONTH_SCOPE_MISMATCH");
  });

  it("rejects expired approvals", () => {
    const raw = manifestJson();
    expect(() =>
      parseAndVerifyManifest(
        raw,
        digest(raw),
        plannerOptions(),
        new Date("2026-08-13T00:00:00Z"),
      ),
    ).toThrow("PARTITION_MANIFEST_EXPIRED");
  });

  it("requires an exact opaque approval ID match", () => {
    const raw = manifestJson();
    const options = plannerOptions();
    options.approvalId = "APR_20260811_002";
    expect(() =>
      parseAndVerifyManifest(raw, digest(raw), options, now),
    ).toThrow("PARTITION_MANIFEST_APPROVAL_MISMATCH");
  });

  it("binds the signed application and migration roles to CLI scope", () => {
    const raw = manifestJson();
    const options = plannerOptions();
    options.applicationRole = "different_app";
    expect(() =>
      parseAndVerifyManifest(raw, digest(raw), options, now),
    ).toThrow("PARTITION_MANIFEST_APPLICATION_ROLE_MISMATCH");
  });

  it("requires database, application, and migration roles to be distinct", () => {
    const parsed = JSON.parse(manifestJson()) as Record<string, unknown>;
    parsed.migrationRole = "streamline_app";
    const raw = JSON.stringify(parsed);
    expect(() =>
      parseAndVerifyManifest(raw, digest(raw), plannerOptions(), now),
    ).toThrow("PARTITION_MANIFEST_INVALID");
  });

  it("requires all five ordered base bundle dependencies", () => {
    const parsed = JSON.parse(manifestJson()) as Record<string, unknown>;
    parsed.baseBundleDependencies = dependencies().slice(0, 4);
    const raw = JSON.stringify(parsed);
    expect(() =>
      parseAndVerifyManifest(raw, digest(raw), plannerOptions(), now),
    ).toThrow("PARTITION_MANIFEST_INVALID");
  });

  it("rejects inconsistent base bundle root identities", () => {
    const parsed = JSON.parse(manifestJson()) as Record<string, unknown>;
    const baseDependencies = dependencies();
    baseDependencies[4] = {
      ...baseDependencies[4],
      rootMigrationSha256: "d".repeat(64),
    };
    parsed.baseBundleDependencies = baseDependencies;
    const raw = JSON.stringify(parsed);
    expect(() =>
      parseAndVerifyManifest(raw, digest(raw), plannerOptions(), now),
    ).toThrow("PARTITION_MANIFEST_INVALID");
  });

  it("requires the planner role to equal the base bundle executor role", () => {
    const parsed = JSON.parse(manifestJson()) as Record<string, unknown>;
    parsed.databaseRole = "different_owner";
    const raw = JSON.stringify(parsed);
    expect(() =>
      parseAndVerifyManifest(raw, digest(raw), plannerOptions(), now),
    ).toThrow("PARTITION_MANIFEST_INVALID");
  });

  it("rejects a dependency operation ID that does not match its tuple", () => {
    const parsed = JSON.parse(manifestJson()) as Record<string, unknown>;
    const baseDependencies = dependencies();
    baseDependencies[2] = {
      ...baseDependencies[2],
      operationId: "hrms-phase1@1:wrong",
    };
    parsed.baseBundleDependencies = baseDependencies;
    const raw = JSON.stringify(parsed);
    expect(() =>
      parseAndVerifyManifest(raw, digest(raw), plannerOptions(), now),
    ).toThrow("PARTITION_MANIFEST_INVALID");
  });

  it("rejects plaintext-compatible approval values", () => {
    const parsed = JSON.parse(manifestJson()) as Record<string, unknown>;
    parsed.approvalId = "Jane Doe <jane@example.invalid>";
    const raw = JSON.stringify(parsed);
    expect(() =>
      parseAndVerifyManifest(raw, digest(raw), plannerOptions(), now),
    ).toThrow("PARTITION_MANIFEST_INVALID");
  });

  it("requires one base owner-only profile per selected table", () => {
    const parsed = JSON.parse(manifestJson()) as Record<string, unknown>;
    parsed.securityProfiles = [
      { table: "attendance_events", profile: "runtime-append-v1" },
      {
        table: "attendance_event_locators",
        profile: "base-owner-only-v1",
      },
    ];
    const raw = JSON.stringify(parsed);
    expect(() =>
      parseAndVerifyManifest(raw, digest(raw), plannerOptions(), now),
    ).toThrow("PARTITION_MANIFEST_INVALID");
  });
});
