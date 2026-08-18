import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertRollbackStateOrder } from "./bundle-rollback-executor";

const source = readFileSync(
  resolve(__dirname, "bundle-rollback-executor.ts"),
  "utf8",
);

describe("HRMS schema bundle rollback order", () => {
  it("accepts a complete prefix followed by an idempotent rolled-back suffix", () => {
    expect(() =>
      assertRollbackStateOrder(
        ["COMPLETE", "COMPLETE", "ROLLED_BACK", "ROLLED_BACK"],
        2,
      ),
    ).not.toThrow();
    expect(() =>
      assertRollbackStateOrder(
        ["COMPLETE", "COMPLETE", "ROLLED_BACK", "ROLLED_BACK"],
        1,
      ),
    ).not.toThrow();
  });

  it("rejects rollback shallower than the durable rollback depth", () => {
    expect(() =>
      assertRollbackStateOrder(
        ["COMPLETE", "COMPLETE", "ROLLED_BACK", "ROLLED_BACK"],
        3,
      ),
    ).toThrow("RUNNER_ROLLBACK_SCOPE_ALREADY_PASSED");
  });

  it("rejects active, failed, missing-order, or complete-after-rolled state", () => {
    expect(() =>
      assertRollbackStateOrder(["COMPLETE", "VERIFYING"], 0),
    ).toThrow("RUNNER_ROLLBACK_ORDER_INVALID");
    expect(() =>
      assertRollbackStateOrder(["COMPLETE", "ROLLED_BACK", "COMPLETE"], 0),
    ).toThrow("RUNNER_ROLLBACK_ORDER_INVALID");
  });

  it("verifies catalog state for fresh and idempotent rollback paths", () => {
    expect(source).toContain("if (!alreadyRolledBack) await tx.unsafe(down.sql)");
    expect(source).toContain("await verifyRolledBackCatalog(");
    expect(source).toContain("RUNNER_ROLLBACK_UNBOUND_OPERATION");
    expect(source.indexOf("await setRollbackContext(")).toBeLessThan(
      source.indexOf("await tx.unsafe(down.sql)"),
    );
  });
});
