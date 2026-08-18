import type { OperationIdentity } from "./bundle-ledger";
import { decideExistingOperation } from "./bundle-ledger";
import {
  operationStateSchema,
  type OperationRow,
} from "./bundle-ledger-schema";

const current: OperationIdentity = {
  operationId: `hrms-phase1@1:0002_hrms_leave_ledger.sql:${"a".repeat(64)}`,
  logicalBundleId: "hrms-phase1@1",
  fileName: "0002_hrms_leave_ledger.sql",
  sqlHash: "b".repeat(64),
  manifestHash: "a".repeat(64),
  rootMigrationHash: "c".repeat(64),
  databaseName: "streamline_staging",
  databaseRole: "schema_owner",
  serverVersion: 160003,
};

function row(overrides: Partial<OperationRow> = {}): OperationRow {
  return {
    operation_id: current.operationId,
    bundle_id: current.logicalBundleId,
    file_name: current.fileName,
    sql_hash: current.sqlHash,
    manifest_hash: current.manifestHash,
    root_migration_hash: current.rootMigrationHash,
    state: "COMPLETE",
    database_name: current.databaseName,
    database_role: current.databaseRole,
    server_version_num: current.serverVersion,
    ...overrides,
  };
}

describe("HRMS schema bundle operation decisions", () => {
  it("runs when the logical file has no history", () => {
    expect(decideExistingOperation([], current)).toBe("run");
  });

  it("skips an identical completed file from an older approval", () => {
    expect(
      decideExistingOperation(
        [row({ operation_id: "older", manifest_hash: "d".repeat(64) })],
        current,
      ),
    ).toBe("skip");
  });

  it("reruns an exact rolled-back operation without treating it as complete", () => {
    expect(operationStateSchema.parse("ROLLED_BACK")).toBe("ROLLED_BACK");
    expect(decideExistingOperation([row({ state: "ROLLED_BACK" })], current))
      .toBe("run");
  });

  it("rejects rolled-back SQL and execution identity drift", () => {
    expect(() =>
      decideExistingOperation(
        [row({ state: "ROLLED_BACK", sql_hash: "e".repeat(64) })],
        current,
      ),
    ).toThrow("RUNNER_PRIOR_COMPLETE_IDENTITY_MISMATCH");
    expect(() =>
      decideExistingOperation(
        [row({ state: "ROLLED_BACK", database_role: "other_owner" })],
        current,
      ),
    ).toThrow("RUNNER_PRIOR_COMPLETE_IDENTITY_MISMATCH");
  });

  it("rejects completed SQL drift for the logical file", () => {
    expect(() =>
      decideExistingOperation([row({ sql_hash: "e".repeat(64) })], current),
    ).toThrow("RUNNER_PRIOR_COMPLETE_IDENTITY_MISMATCH");
  });

  it("preserves a failed approval and requires renewal", () => {
    expect(() =>
      decideExistingOperation([row({ state: "FAILED" })], current),
    ).toThrow("RUNNER_APPROVAL_ALREADY_FAILED");
  });

  it("rejects an impossible durable active state", () => {
    expect(() =>
      decideExistingOperation([row({ state: "VERIFYING" })], current),
    ).toThrow("RUNNER_PRIOR_OPERATION_ACTIVE");
  });
});
