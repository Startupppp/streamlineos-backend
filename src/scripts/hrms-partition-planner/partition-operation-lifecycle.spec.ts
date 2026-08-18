import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safePartitionFailureCode } from "./partition-error";

const executor = readFileSync(
  join(__dirname, "partition-executor.ts"),
  "utf8",
);
const ledger = readFileSync(
  join(__dirname, "partition-operation-ledger.ts"),
  "utf8",
);
const cli = readFileSync(join(__dirname, "hrms-partitions.ts"), "utf8");

describe("HRMS partition operation lifecycle", () => {
  it("verifies base provenance and claims the operation before DDL", () => {
    const applyBody = executor.slice(executor.indexOf("async function applySingle"));
    expect(applyBody.indexOf("verifyBaseBundleDependencies(tx, verified)"))
      .toBeLessThan(applyBody.indexOf("claimPartitionOperation(tx, identity)"));
    expect(applyBody.indexOf("claimPartitionOperation(tx, identity)"))
      .toBeLessThan(applyBody.indexOf("tx.unsafe(installPartitionHelpersSql)"));
    expect(executor.indexOf("await assertPartitionOperationLedgerReady("))
      .toBeLessThan(executor.indexOf("applySinglePartition(client, item"));
  });

  it("requires the exact approved child set after all operations", () => {
    expect(executor).toContain("assertPartitionSet(tx, first.parent, items, true)");
    expect(executor).toContain("assertPartitionSet(tx, parent, items, false)");
    expect(executor.indexOf("verifyFinalPartitionSet(client, byParent, verified)"))
      .toBeGreaterThan(executor.indexOf("reportResult(result)"));
  });

  it("persists verification only around exact catalog verification", () => {
    const verifying = executor.indexOf(
      'transitionPartitionOperation(tx, identity, "RUNNING", "VERIFYING")',
    );
    const catalog = executor.indexOf("verifyPartition(tx, item, profile)", verifying);
    const complete = executor.indexOf(
      'transitionPartitionOperation(tx, identity, "VERIFYING", "COMPLETE")',
    );
    expect(verifying).toBeGreaterThan(-1);
    expect(catalog).toBeGreaterThan(verifying);
    expect(complete).toBeGreaterThan(catalog);
  });

  it("binds every transition to the durable identity", () => {
    for (const predicate of [
      "approval_id = ${current.approvalId}",
      "base_bundle_id = ${current.baseBundleId}",
      "root_migration_hash = ${current.rootMigrationHash}",
      "base_dependencies_hash = ${current.baseDependenciesHash}",
      "database_name = ${current.databaseName}",
      "database_role = ${current.databaseRole}",
      "parent_table = ${current.parentTable}",
      "child_table = ${current.childTable}",
      "security_profile = ${current.securityProfile}",
      "ddl_hash = ${current.ddlHash}",
    ])
      expect(ledger).toContain(predicate);
  });

  it("bounds the independent failure-record transaction", () => {
    const failureWriter = ledger.slice(
      ledger.indexOf("export async function recordPartitionOperationFailure"),
    );
    expect(failureWriter).toContain("SET LOCAL lock_timeout = '5s'");
    expect(failureWriter).toContain("SET LOCAL statement_timeout = '30s'");
    expect(failureWriter).toContain(
      "SET LOCAL idle_in_transaction_session_timeout = '60s'",
    );
  });

  it("never exposes an unknown database error message", () => {
    expect(safePartitionFailureCode(new Error("customer secret")))
      .toBe("PARTITION_OPERATION_FAILED");
    expect(safePartitionFailureCode({ code: "23505" }))
      .toBe("PARTITION_DATABASE_23505");
    expect(cli).toContain("const code = safePartitionFailureCode(error)");
    expect(cli).not.toContain("error.message");
  });
});
