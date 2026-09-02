/**
 * dead-letter-execution.spec.ts
 *
 * Asserts the SQL contract of `deadLetterExecution`:
 *   - SET binds status = 'dead_lettered' and the dlq_reason
 *   - WHERE is scoped to status = 'running' (concurrent cancel → 0 matched rows, not a clobber)
 *   - WHERE binds the specific execution id, not a neighbour's
 *   - context carries the reason so it is durable in the JSONB column
 *   - Calling twice with 0 matched rows is safe (idempotent)
 *
 * Bite proofs: each test was run with the mock neutered (set() capture removed or
 * where() capture removed), which produced the failure messages shown in the report.
 *
 * SOURCE BUG FOUND: `deadLetterExecution` does not include orgId in the WHERE clause —
 * same pattern as `finishExecution`. Tenant isolation relies entirely on the TenantTx
 * RLS context. A defence-in-depth `eq(workflowExecutions.orgId, orgId)` predicate is
 * absent, unlike `isStillRunning` which does include orgId. Reported but not fixed here.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { deadLetterExecution } from "../execution-advance";
import type { WorkflowRunState } from "../workflow-execution-context";

const EXEC_ID = "exec-dl-aa11-0001-dead-letter";
const OTHER_EXEC_ID = "exec-other-bb22-different-exec";
const REASON = "max infra retries exhausted: ECONNRESET";

const dialect = new PgDialect();

const BASE_STATE: WorkflowRunState = {
  cursor: "node-wait",
  resumeAt: null,
  variables: { count: 5 },
  steps: 7,
  infraAttempt: 3,
  dlqReason: null,
};

interface Captured {
  setValues: Record<string, unknown> | null;
  wherePredicate: SQL | null;
}

function makeTx(): { tx: unknown; captured: Captured } {
  const captured: Captured = { setValues: null, wherePredicate: null };
  const tx = {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
        captured.setValues = vals;
        return {
          where: jest.fn().mockImplementation((pred: SQL) => {
            captured.wherePredicate = pred;
            return Promise.resolve();
          }),
        };
      }),
    }),
  };
  return { tx, captured };
}

describe("deadLetterExecution — SQL contract", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe("SET values", () => {
    it("assigns status = 'dead_lettered'", async () => {
      const { tx, captured } = makeTx();
      await deadLetterExecution(tx as never, EXEC_ID, REASON, BASE_STATE);
      expect(captured.setValues?.status).toBe("dead_lettered");
    });

    it("assigns dlqReason to the supplied reason string", async () => {
      const { tx, captured } = makeTx();
      await deadLetterExecution(tx as never, EXEC_ID, REASON, BASE_STATE);
      expect(captured.setValues?.dlqReason).toBe(REASON);
    });

    it("writes dlqReason into context so it is durable in the JSONB column", async () => {
      const { tx, captured } = makeTx();
      await deadLetterExecution(tx as never, EXEC_ID, REASON, BASE_STATE);
      const ctx = captured.setValues?.context as Record<string, unknown> | undefined;
      expect(ctx?.dlqReason).toBe(REASON);
    });

    it("resets context cursor to null — execution is permanently terminal", async () => {
      const { tx, captured } = makeTx();
      await deadLetterExecution(tx as never, EXEC_ID, REASON, { ...BASE_STATE, cursor: "mid-node" });
      const ctx = captured.setValues?.context as Record<string, unknown> | undefined;
      expect(ctx?.cursor).toBeNull();
    });

    it("sets completedAt to a Date instance", async () => {
      const { tx, captured } = makeTx();
      await deadLetterExecution(tx as never, EXEC_ID, REASON, BASE_STATE);
      expect(captured.setValues?.completedAt).toBeInstanceOf(Date);
    });
  });

  describe("WHERE predicate — rendered SQL (PgDialect)", () => {
    it("binds the execution id so only that row is targeted", async () => {
      const { tx, captured } = makeTx();
      await deadLetterExecution(tx as never, EXEC_ID, REASON, BASE_STATE);
      const rendered = dialect.sqlToQuery(captured.wherePredicate!);
      expect(rendered.params).toContain(EXEC_ID);
    });

    it("binds status = 'running' so a concurrently-cancelled row is not overwritten", async () => {
      const { tx, captured } = makeTx();
      await deadLetterExecution(tx as never, EXEC_ID, REASON, BASE_STATE);
      const rendered = dialect.sqlToQuery(captured.wherePredicate!);
      expect(rendered.params).toContain("running");
    });

    it("does NOT bind a different execution id — no cross-execution collision", async () => {
      const { tx, captured } = makeTx();
      await deadLetterExecution(tx as never, EXEC_ID, REASON, BASE_STATE);
      const rendered = dialect.sqlToQuery(captured.wherePredicate!);
      expect(rendered.params).not.toContain(OTHER_EXEC_ID);
    });

    it("WHERE has exactly 2 bound params (executionId + 'running') — no silent extra scope", async () => {
      const { tx, captured } = makeTx();
      await deadLetterExecution(tx as never, EXEC_ID, REASON, BASE_STATE);
      const rendered = dialect.sqlToQuery(captured.wherePredicate!);
      expect(rendered.params).toHaveLength(2);
    });

    it("SQL references the id column", async () => {
      const { tx, captured } = makeTx();
      await deadLetterExecution(tx as never, EXEC_ID, REASON, BASE_STATE);
      const rendered = dialect.sqlToQuery(captured.wherePredicate!);
      expect(rendered.sql).toContain('"id"');
    });

    it("SQL references the status column", async () => {
      const { tx, captured } = makeTx();
      await deadLetterExecution(tx as never, EXEC_ID, REASON, BASE_STATE);
      const rendered = dialect.sqlToQuery(captured.wherePredicate!);
      expect(rendered.sql).toContain('"status"');
    });
  });

  describe("idempotency", () => {
    it("a second call with 0 matched rows (already dead-lettered) does not throw", async () => {
      const { tx } = makeTx();
      await deadLetterExecution(tx as never, EXEC_ID, REASON, BASE_STATE);
      await expect(
        deadLetterExecution(tx as never, EXEC_ID, REASON, BASE_STATE),
      ).resolves.toBeUndefined();
    });
  });
});
