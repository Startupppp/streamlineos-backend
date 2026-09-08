/**
 * Durable retry / DLQ / bounded-history spec — workflows execution engine.
 *
 * Three coverage groups:
 *  A — Infrastructure failure retries; deterministic failure does NOT retry.
 *  B — Exhausted retry budget lands in `dead_lettered` state with reason preserved.
 *  C — Step history is bounded: pruneOrgSteps deletes steps for old terminal executions.
 *
 * Groups A and B unit-test runOne's error-handling path by mocking execution-advance
 * so the dispatcher-level throw reaches the outer catch directly.
 *
 * Bite proof (Group A test "transient ECONNRESET triggers releaseToWaiting"):
 *   To prove the assertion bites, the `status: "waiting"` write was removed from
 *   the DB mock's setMock, making allSetCalls never contain a waiting entry.
 *   The assertion `expect(waitingCall).toBeDefined()` then fails with:
 *     "expect(received).toBeDefined() — received: undefined"
 *   Restoring the mock makes the test pass.
 */

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: async <T>(
    db: unknown,
    _orgId: string,
    fn: (tx: unknown) => Promise<T>,
  ): Promise<T> => fn(db),
  runInTenantTransaction: async <T>(
    db: unknown,
    fn: (tx: unknown) => Promise<T>,
  ): Promise<T> => fn(db),
}));

jest.mock("../../../common/tenant/for-each-org", () => ({
  forEachOrg: async (
    db: unknown,
    _sweep: string,
    fn: (tx: unknown, orgId: string) => Promise<void>,
  ) => {
    await fn(db, "org-rdh-test");
    return { organizations: 1, succeeded: 1, failed: 0 };
  },
}));

jest.mock("../engine/execution-advance", () => ({
  advanceExecution: jest.fn(),
  deadLetterExecution: jest.fn().mockResolvedValue(undefined),
  deadLetterExecutions: jest.fn().mockResolvedValue(undefined),
  finishExecution: jest.fn().mockResolvedValue(undefined),
  MAX_STEPS_PER_EXECUTION: 200,
}));

import { WorkflowRunnerService, isTransientInfraError } from "../engine/workflow-runner.service";
import {
  advanceExecution,
  deadLetterExecution,
  deadLetterExecutions,
  finishExecution,
} from "../engine/execution-advance";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { WorkflowRunState } from "../engine/workflow-execution-context";
import { OUTBOX_MAX_RETRIES } from "../../../common/outbox/outbox-envelope";
import type { Db } from "../../../db/drizzle.module";
import type { NodeDispatchPort } from "../engine/node-outcome";
import type { AccessService } from "../../access/access.service";

const ORG = "org-rdh-test";

const BASE_EXECUTION = {
  id: "exec-rdh-1",
  orgId: ORG,
  workflowVersionId: "wv-rdh-1",
  triggerData: null,
  context: null,
  triggeredBy: "user-trigger",
};

function makeDb(claimRows: object[]): Db & { allSetCalls: Array<Record<string, unknown>> } {
  const allSetCalls: Array<Record<string, unknown>> = [];
  const returningFn = jest.fn()
    .mockResolvedValueOnce(claimRows)
    .mockResolvedValue([]);
  const whereResult = Object.assign(Promise.resolve([]), { returning: returningFn });
  const setMock = jest.fn().mockImplementation((vals: Record<string, unknown>) => {
    allSetCalls.push(vals);
    return { where: jest.fn().mockReturnValue(whereResult) };
  });
  const db = {
    update: jest.fn().mockReturnValue({ set: setMock }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
      }),
    }),
  } as unknown as Db;
  return Object.assign(db, { allSetCalls });
}

function makeService(db: Db, opts: { accessError?: unknown } = {}): WorkflowRunnerService {
  const access = {
    resolveUserPermissions: opts.accessError
      ? jest.fn().mockRejectedValue(opts.accessError)
      : jest.fn().mockResolvedValue({}),
  } as unknown as AccessService;
  const dispatcher = { execute: jest.fn() } as unknown as NodeDispatchPort;
  return new WorkflowRunnerService(db, dispatcher, access);
}

type PrivateRunner = { runOne(orgId: string, id: string): Promise<string | null> };

beforeEach(() => {
  jest.clearAllMocks();
  (advanceExecution as jest.Mock).mockResolvedValue("completed");
  (deadLetterExecution as jest.Mock).mockResolvedValue(undefined);
  (deadLetterExecutions as jest.Mock).mockResolvedValue(undefined);
  (finishExecution as jest.Mock).mockResolvedValue(undefined);
});

// Group A — Infrastructure failure retries; deterministic failure does not

describe("A — infra failure retries; deterministic failure does not", () => {
  it("a transient ECONNRESET from advanceExecution triggers releaseToWaiting (retry)", async () => {
    const transientError = Object.assign(Object.create(null) as object, { code: "ECONNRESET" });
    (advanceExecution as jest.Mock).mockRejectedValueOnce(transientError);
    const db = makeDb([BASE_EXECUTION]);
    const svc = makeService(db);

    const result = await (svc as unknown as PrivateRunner).runOne(ORG, BASE_EXECUTION.id);

    expect(result).toBe("suspended");
    const waitingCall = db.allSetCalls.find((c) => c["status"] === "waiting");
    expect(waitingCall).toBeDefined();
    const ctx = waitingCall?.["context"] as Record<string, unknown> | undefined;
    expect(ctx?.["infraAttempt"]).toBe(1);
    expect(ctx?.["resumeAt"]).toBeDefined();
  });

  it("infraAttempt increments from 2 to 3 on the third transient failure", async () => {
    const contextWith2Attempts = {
      cursor: null, resumeAt: null, variables: {}, steps: 0,
      infraAttempt: 2, dlqReason: null,
    };
    const transientError = Object.assign(Object.create(null) as object, { code: "ETIMEDOUT" });
    (advanceExecution as jest.Mock).mockRejectedValueOnce(transientError);
    const db = makeDb([{ ...BASE_EXECUTION, context: contextWith2Attempts }]);
    const svc = makeService(db);

    const result = await (svc as unknown as PrivateRunner).runOne(ORG, BASE_EXECUTION.id);

    expect(result).toBe("suspended");
    const waitingCall = db.allSetCalls.find((c) => c["status"] === "waiting");
    const ctx = waitingCall?.["context"] as Record<string, unknown> | undefined;
    expect(ctx?.["infraAttempt"]).toBe(3);
  });

  it("a deterministic domain error from advanceExecution fails immediately without retry", async () => {
    const domainError = new Error("workflow definition references a deleted node");
    (advanceExecution as jest.Mock).mockRejectedValueOnce(domainError);
    const db = makeDb([BASE_EXECUTION]);
    const svc = makeService(db);

    const result = await (svc as unknown as PrivateRunner).runOne(ORG, BASE_EXECUTION.id);

    expect(result).toBe("failed");
    const waitingCall = db.allSetCalls.find((c) => c["status"] === "waiting");
    expect(waitingCall).toBeUndefined();
    expect(finishExecution).toHaveBeenCalledWith(expect.anything(), ORG, BASE_EXECUTION.id, "failed");
  });

  it("isTransientInfraError returns false for a plain domain Error (no code)", () => {
    expect(isTransientInfraError(new Error("some domain failure"))).toBe(false);
  });

  it("isTransientInfraError returns true for ECONNRESET cross-realm object (no prototype)", () => {
    const err = Object.assign(Object.create(null) as object, { code: "ECONNRESET" });
    expect(isTransientInfraError(err)).toBe(true);
  });
});

// Group B — Exhausted retry budget → dead_lettered state with reason preserved

describe("B — exhausted retry budget lands in dead_lettered state", () => {
  it("when infraAttempt = OUTBOX_MAX_RETRIES and advance throws transiently, returns dead_lettered", async () => {
    const exhaustedCtx = {
      cursor: null, resumeAt: null, variables: {}, steps: 0,
      infraAttempt: OUTBOX_MAX_RETRIES, dlqReason: null,
    };
    const transientError = Object.assign(Object.create(null) as object, { code: "ECONNRESET" });
    (advanceExecution as jest.Mock).mockRejectedValueOnce(transientError);
    const db = makeDb([{ ...BASE_EXECUTION, context: exhaustedCtx }]);
    const svc = makeService(db);

    const result = await (svc as unknown as PrivateRunner).runOne(ORG, BASE_EXECUTION.id);

    expect(result).toBe("dead_lettered");
    expect(deadLetterExecution).toHaveBeenCalledTimes(1);
  });

  it("the dlqReason is preserved on the deadLetterExecution call", async () => {
    const exhaustedCtx = {
      cursor: null, resumeAt: null, variables: {}, steps: 0,
      infraAttempt: OUTBOX_MAX_RETRIES, dlqReason: null,
    };
    const transientError = Object.assign(Object.create(null) as object, {
      code: "ECONNRESET",
      message: "connection reset by peer",
    });
    (advanceExecution as jest.Mock).mockRejectedValueOnce(transientError);
    const db = makeDb([{ ...BASE_EXECUTION, context: exhaustedCtx }]);
    const svc = makeService(db);

    await (svc as unknown as PrivateRunner).runOne(ORG, BASE_EXECUTION.id);

    expect(deadLetterExecution).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      BASE_EXECUTION.id,
      "connection reset by peer",
      expect.objectContaining({ infraAttempt: OUTBOX_MAX_RETRIES }),
    );
  });

  it("when infraAttempt = OUTBOX_MAX_RETRIES and permission-resolve throws transiently, returns dead_lettered", async () => {
    const exhaustedCtx = {
      cursor: null, resumeAt: null, variables: {}, steps: 0,
      infraAttempt: OUTBOX_MAX_RETRIES, dlqReason: null,
    };
    const transientError = Object.assign(Object.create(null) as object, { code: "ETIMEDOUT" });
    const db = makeDb([{ ...BASE_EXECUTION, context: exhaustedCtx }]);
    const svc = makeService(db, { accessError: transientError });

    const result = await (svc as unknown as PrivateRunner).runOne(ORG, BASE_EXECUTION.id);

    expect(result).toBe("dead_lettered");
    expect(deadLetterExecution).toHaveBeenCalledTimes(1);
  });

  it("a deterministic domain error at infraAttempt = OUTBOX_MAX_RETRIES still fails (not DLQ'd)", async () => {
    const exhaustedCtx = {
      cursor: null, resumeAt: null, variables: {}, steps: 0,
      infraAttempt: OUTBOX_MAX_RETRIES, dlqReason: null,
    };
    const domainError = new Error("authorization denied");
    (advanceExecution as jest.Mock).mockRejectedValueOnce(domainError);
    const db = makeDb([{ ...BASE_EXECUTION, context: exhaustedCtx }]);
    const svc = makeService(db);

    const result = await (svc as unknown as PrivateRunner).runOne(ORG, BASE_EXECUTION.id);

    expect(result).toBe("failed");
    expect(deadLetterExecution).not.toHaveBeenCalled();
    expect(finishExecution).toHaveBeenCalledWith(expect.anything(), ORG, BASE_EXECUTION.id, "failed");
  });

  it("no retry happens once budget is exhausted — status is not set to waiting", async () => {
    const exhaustedCtx = {
      cursor: null, resumeAt: null, variables: {}, steps: 0,
      infraAttempt: OUTBOX_MAX_RETRIES, dlqReason: null,
    };
    const transientError = Object.assign(Object.create(null) as object, { code: "ECONNRESET" });
    (advanceExecution as jest.Mock).mockRejectedValueOnce(transientError);
    const db = makeDb([{ ...BASE_EXECUTION, context: exhaustedCtx }]);
    const svc = makeService(db);

    await (svc as unknown as PrivateRunner).runOne(ORG, BASE_EXECUTION.id);

    const waitingCall = db.allSetCalls.find((c) => c["status"] === "waiting");
    expect(waitingCall).toBeUndefined();
  });
});

// Group C — Step history is bounded: sweep prunes old terminal-execution steps

describe("C — step history is bounded by the sweep pruning pass", () => {
  function makeDbWithPruneSetup(oldExecIds: string[], deletedSteps: object[]): Db {
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue(Object.assign(Promise.resolve([]), {
        returning: jest.fn().mockResolvedValue([]),
      })),
    });
    const deletedReturning = jest.fn().mockResolvedValue(deletedSteps);
    const selectLimit = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(oldExecIds.map((id) => ({ id })));
    return {
      update: jest.fn().mockReturnValue({ set: setMock }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: selectLimit }),
        }),
      }),
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: deletedReturning }),
      }),
    } as unknown as Db;
  }

  it("sweep prunes steps for old terminal executions and reports stepsPruned count", async () => {
    const db = makeDbWithPruneSetup(
      ["exec-old-1", "exec-old-2"],
      [{ id: "step-1" }, { id: "step-2" }, { id: "step-3" }],
    );
    const svc = new WorkflowRunnerService(
      db,
      { execute: jest.fn() } as unknown as NodeDispatchPort,
      { resolveUserPermissions: jest.fn() } as unknown as AccessService,
    );

    const result = await svc.sweep();

    expect(result.stepsPruned).toBe(3);
    expect(result.claimed).toBe(0);
  });

  it("sweep reports 0 stepsPruned when no terminal executions are past the retention window", async () => {
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue(Object.assign(Promise.resolve([]), {
        returning: jest.fn().mockResolvedValue([]),
      })),
    });
    const deleteMock = jest.fn();
    const db = {
      update: jest.fn().mockReturnValue({ set: setMock }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
      delete: deleteMock,
    } as unknown as Db;

    const svc = new WorkflowRunnerService(
      db,
      { execute: jest.fn() } as unknown as NodeDispatchPort,
      { resolveUserPermissions: jest.fn() } as unknown as AccessService,
    );

    const result = await svc.sweep();

    expect(result.stepsPruned).toBe(0);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("delete is not called when pruneOrgSteps finds no executions past cutoff", async () => {
    const deleteSpy = jest.fn();
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue(Object.assign(Promise.resolve([]), {
        returning: jest.fn().mockResolvedValue([]),
      })),
    });
    const db = {
      update: jest.fn().mockReturnValue({ set: setMock }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
      delete: deleteSpy,
    } as unknown as Db;

    const svc = new WorkflowRunnerService(
      db,
      { execute: jest.fn() } as unknown as NodeDispatchPort,
      { resolveUserPermissions: jest.fn() } as unknown as AccessService,
    );

    await svc.sweep();

    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

// Group D — Expired lease reclaim: expireStuck re-queues crashed workers
// Bite proof (test "below-budget stuck execution released to waiting"):
//   Before implementing the SELECT+loop in expireStuck, the function issued a
//   batch UPDATE to timed_out without reading any rows. The Group D tests were
//   run against that old implementation:
//     - "waitingCall" was undefined → expect(waitingCall).toBeDefined() FAILED.
//     - "timedOutCall" was defined → expect(timedOutCall).toBeUndefined() FAILED.
//   After rewriting expireStuck to SELECT rows then conditionally UPDATE to
//   waiting/dead_lettered, all Group D tests pass.

describe("D — expired lease reclaim: expireStuck re-queues crashed workers", () => {
  type PrivateStuck = { expireStuck(tx: unknown, orgId: string): Promise<void> };

  /*
   * The release is now one `UPDATE … FROM (VALUES …)` for the whole batch
   * instead of one statement per execution, so the values this group asserts on
   * ride as bind parameters rather than as a `.set({...})` object. Both capture
   * paths feed `allSetCalls`, so every assertion below still reads what the
   * runner actually wrote — and would still see a `timed_out` written either way.
   */
  function makeTxWithStuck(rows: object[]): {
    tx: unknown;
    allSetCalls: Array<Record<string, unknown>>;
    statements: number;
  } {
    const allSetCalls: Array<Record<string, unknown>> = [];
    const captured = { statements: 0 };
    const tx = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(rows),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
          allSetCalls.push(vals);
          return { where: jest.fn().mockReturnValue(Promise.resolve()) };
        }),
      }),
      execute: jest.fn().mockImplementation((statement: SQL) => {
        captured.statements += 1;
        const { params } = new PgDialect().sqlToQuery(statement);
        const keys: Array<string | number> = [];
        for (let i = 0; i + 2 < params.length; i += 3) {
          const [key, status, context] = [params[i], params[i + 1], params[i + 2]];
          if (typeof status !== "string" || typeof context !== "string") break;
          let parsed: unknown;
          try {
            parsed = JSON.parse(context);
          } catch {
            break;
          }
          allSetCalls.push({ status, context: parsed as Record<string, unknown> });
          keys.push(key as string | number);
        }
        return Promise.resolve(keys.map((key) => ({ key })));
      }),
    };
    return {
      tx,
      allSetCalls,
      get statements() {
        return captured.statements;
      },
    };
  }

  function makeMinimalService(): WorkflowRunnerService {
    const db = {} as unknown as Db;
    const dispatcher = { execute: jest.fn() } as unknown as NodeDispatchPort;
    const access = { resolveUserPermissions: jest.fn() } as unknown as AccessService;
    return new WorkflowRunnerService(db, dispatcher, access);
  }

  beforeEach(() => {
    (deadLetterExecutions as jest.Mock).mockResolvedValue(undefined);
  });

  it("a stuck running execution below budget is released to waiting with incremented infraAttempt", async () => {
    const stuckCtx = { cursor: "node-a", resumeAt: null, variables: {}, steps: 3, infraAttempt: 1, dlqReason: null };
    const { tx, allSetCalls } = makeTxWithStuck([{ id: "exec-stuck-1", context: stuckCtx }]);
    const svc = makeMinimalService();

    await (svc as unknown as PrivateStuck).expireStuck(tx, ORG);

    const waitingCall = allSetCalls.find((c) => c["status"] === "waiting");
    expect(waitingCall).toBeDefined();
    const ctx = waitingCall?.["context"] as Record<string, unknown> | undefined;
    expect(ctx?.["infraAttempt"]).toBe(2);
    expect(ctx?.["resumeAt"]).toBeDefined();
  });

  it("the whole stuck batch is released by ONE statement, not one per execution", async () => {
    const rows = [1, 2, 3].map((n) => ({
      id: `exec-batch-${n}`,
      context: { cursor: `node-${n}`, resumeAt: null, variables: {}, steps: 1, infraAttempt: 0, dlqReason: null },
    }));
    const captured = makeTxWithStuck(rows);
    const svc = makeMinimalService();

    await (svc as unknown as PrivateStuck).expireStuck(captured.tx, ORG);

    expect(captured.statements).toBe(1);
    expect(captured.allSetCalls.filter((c) => c["status"] === "waiting")).toHaveLength(3);
  });

  it("the released execution has a future resumeAt (backoff is non-zero)", async () => {
    const before = Date.now();
    const stuckCtx = { cursor: "node-b", resumeAt: null, variables: {}, steps: 1, infraAttempt: 0, dlqReason: null };
    const { tx, allSetCalls } = makeTxWithStuck([{ id: "exec-stuck-2", context: stuckCtx }]);
    const svc = makeMinimalService();

    await (svc as unknown as PrivateStuck).expireStuck(tx, ORG);

    const waitingCall = allSetCalls.find((c) => c["status"] === "waiting");
    const ctx = waitingCall?.["context"] as Record<string, unknown> | undefined;
    const resumeAt = new Date(String(ctx?.["resumeAt"]));
    expect(resumeAt.getTime()).toBeGreaterThan(before);
  });

  it("expireStuck does NOT set timed_out — crashed runs below budget are not permanently lost", async () => {
    const stuckCtx = { cursor: "node-c", resumeAt: null, variables: {}, steps: 2, infraAttempt: 2, dlqReason: null };
    const { tx, allSetCalls } = makeTxWithStuck([{ id: "exec-stuck-3", context: stuckCtx }]);
    const svc = makeMinimalService();

    await (svc as unknown as PrivateStuck).expireStuck(tx, ORG);

    const timedOutCall = allSetCalls.find((c) => c["status"] === "timed_out");
    expect(timedOutCall).toBeUndefined();
  });

  it("every exhausted stuck execution is dead-lettered by ONE batched call carrying all of them", async () => {
    const exhaustedRows = [4, 5, 6].map((n) => ({
      id: `exec-stuck-${n}`,
      context: {
        cursor: `node-${n}`, resumeAt: null, variables: { n }, steps: 5,
        infraAttempt: OUTBOX_MAX_RETRIES, dlqReason: null,
      },
    }));
    const { tx } = makeTxWithStuck(exhaustedRows);
    const svc = makeMinimalService();

    await (svc as unknown as PrivateStuck).expireStuck(tx, ORG);

    expect(deadLetterExecutions).toHaveBeenCalledTimes(1);
    expect(deadLetterExecutions).toHaveBeenCalledWith(
      tx,
      ORG,
      exhaustedRows.map((row) => ({
        executionId: row.id,
        reason: expect.stringContaining("timed out"),
        state: expect.objectContaining({
          cursor: row.context.cursor,
          steps: 5,
          infraAttempt: OUTBOX_MAX_RETRIES,
        }),
      })),
    );
    expect(deadLetterExecution).not.toHaveBeenCalled();
  });

  it("the reason is identical for every execution in the batch", async () => {
    const exhaustedRows = [7, 8].map((n) => ({
      id: `exec-stuck-${n}`,
      context: {
        cursor: `node-${n}`, resumeAt: null, variables: {}, steps: 1,
        infraAttempt: OUTBOX_MAX_RETRIES, dlqReason: null,
      },
    }));
    const { tx } = makeTxWithStuck(exhaustedRows);
    const svc = makeMinimalService();

    await (svc as unknown as PrivateStuck).expireStuck(tx, ORG);

    const targets = (deadLetterExecutions as jest.Mock).mock.calls[0]?.[2] as
      | Array<{ executionId: string; reason: string }>
      | undefined;
    expect(targets?.map((t) => t.executionId)).toEqual(["exec-stuck-7", "exec-stuck-8"]);
    expect(new Set(targets?.map((t) => t.reason)).size).toBe(1);
  });

  it("an exhausted stuck run is NOT released to waiting — budget is the gate", async () => {
    const exhaustedCtx = {
      cursor: "node-e", resumeAt: null, variables: {}, steps: 5,
      infraAttempt: OUTBOX_MAX_RETRIES, dlqReason: null,
    };
    const { tx, allSetCalls } = makeTxWithStuck([{ id: "exec-stuck-5", context: exhaustedCtx }]);
    const svc = makeMinimalService();

    await (svc as unknown as PrivateStuck).expireStuck(tx, ORG);

    const waitingCall = allSetCalls.find((c) => c["status"] === "waiting");
    expect(waitingCall).toBeUndefined();
  });

  it("no updates or DLQ calls are made when there are no stuck running executions", async () => {
    const { tx, allSetCalls } = makeTxWithStuck([]);
    const svc = makeMinimalService();

    await (svc as unknown as PrivateStuck).expireStuck(tx, ORG);

    expect(allSetCalls).toHaveLength(0);
    expect(deadLetterExecutions).not.toHaveBeenCalled();
  });
});

describe("E — the batched dead-letter statement, rendered", () => {
  const engine = jest.requireActual<typeof import("../engine/execution-advance")>(
    "../engine/execution-advance",
  );
  const dialect = new PgDialect();
  const DLQ_REASON = `execution timed out after ${OUTBOX_MAX_RETRIES} infra attempts`;

  const DEAD_LETTER_COLUMN_NAMES: Record<string, string> = {
    status: "status",
    dlqReason: "dlq_reason",
    completedAt: "completed_at",
    durationMs: "duration_ms",
    context: "context",
  };

  function stateFor(n: number): WorkflowRunState {
    return {
      cursor: `node-${n}`,
      resumeAt: null,
      variables: { n },
      steps: n,
      infraAttempt: OUTBOX_MAX_RETRIES,
      dlqReason: null,
    };
  }

  const TARGETS = [1, 2, 3].map((n) => ({
    executionId: `exec-dlq-${n}`,
    reason: DLQ_REASON,
    state: stateFor(n),
  }));

  function makeExecuteTx(): { tx: unknown; statements: SQL[] } {
    const statements: SQL[] = [];
    const tx = {
      execute: jest.fn().mockImplementation((statement: SQL) => {
        statements.push(statement);
        return Promise.resolve([]);
      }),
    };
    return { tx, statements };
  }

  async function render(
    targets: ReadonlyArray<{ executionId: string; reason: string; state: WorkflowRunState }>,
  ): Promise<{ statements: SQL[]; sql: string; params: unknown[] }> {
    const { tx, statements } = makeExecuteTx();
    await engine.deadLetterExecutions(tx as never, ORG, targets);
    const [statement] = statements;
    if (statement === undefined) return { statements, sql: "", params: [] };
    const query = dialect.sqlToQuery(statement);
    return { statements, sql: query.sql, params: query.params };
  }

  it("N exhausted executions produce exactly ONE statement", async () => {
    const { statements } = await render(TARGETS);
    expect(statements).toHaveLength(1);
  });

  it("an empty batch issues no statement at all", async () => {
    const { statements } = await render([]);
    expect(statements).toHaveLength(0);
  });

  it("refuses a batch that repeats an execution — a dropped VALUES row is a lost dead-letter", async () => {
    const { tx, statements } = makeExecuteTx();
    await expect(
      engine.deadLetterExecutions(tx as never, ORG, [TARGETS[0], TARGETS[0]]),
    ).rejects.toThrow("appears twice");
    expect(statements).toHaveLength(0);
  });

  it("sets exactly the terminal dead-letter columns the single form sets", async () => {
    const singleSet: Array<Record<string, unknown>> = [];
    const updateTx = {
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
          singleSet.push(vals);
          return { where: jest.fn().mockReturnValue(Promise.resolve()) };
        }),
      }),
    };
    await engine.deadLetterExecution(
      updateTx as never,
      ORG,
      "exec-dlq-1",
      DLQ_REASON,
      stateFor(1),
    );
    const singleColumns = Object.keys(singleSet[0] ?? {})
      .map((key) => DEAD_LETTER_COLUMN_NAMES[key])
      .sort();
    expect(singleColumns).toEqual(["completed_at", "context", "dlq_reason", "duration_ms", "status"]);

    const { sql } = await render(TARGETS);
    const setClause = sql.slice(sql.indexOf(" SET "), sql.indexOf(" FROM (VALUES"));
    const batchedColumns = [...setClause.matchAll(/"(\w+)" =/g)].map((m) => m[1]).sort();
    expect(batchedColumns).toEqual(singleColumns);
  });

  it("takes the per-execution columns from the VALUES join and duration_ms from started_at", async () => {
    const { sql } = await render(TARGETS);
    expect(sql).toContain('UPDATE "workflow_executions"');
    expect(sql).toContain('"status" = v."status"');
    expect(sql).toContain('"dlq_reason" = v."dlq_reason"');
    expect(sql).toContain('"completed_at" = v."completed_at"');
    expect(sql).toContain('"context" = v."context"');
    expect(sql).toContain(
      '"duration_ms" = EXTRACT(EPOCH FROM (now() - COALESCE("workflow_executions"."started_at", now()))) * 1000',
    );
    expect(sql).toContain('AS v("id", "status", "dlq_reason", "completed_at", "context")');
  });

  it("is tenant-scoped on org_id and compare-and-set on status = running", async () => {
    const { sql, params } = await render(TARGETS);
    expect(sql).toContain('"workflow_executions"."id" = v."id"');
    expect(sql).toContain('"workflow_executions"."org_id" = $');
    expect(sql).toContain('"workflow_executions"."status" = $');
    expect(params).toContain(ORG);
    expect(params).toContain("running");
  });

  it("carries every exhausted id, and one dead_lettered/reason pair per execution", async () => {
    const { params } = await render(TARGETS);
    for (const target of TARGETS) expect(params).toContain(target.executionId);
    expect(params.filter((p) => p === "dead_lettered")).toHaveLength(TARGETS.length);
    expect(params.filter((p) => p === DLQ_REASON)).toHaveLength(TARGETS.length);
  });

  it("freezes each execution's own run state — reason durable in context, cursor cleared", async () => {
    const { params } = await render(TARGETS);
    const contexts = params
      .filter((p): p is string => typeof p === "string" && p.startsWith("{"))
      .map((p) => JSON.parse(p) as Record<string, unknown>);
    expect(contexts).toHaveLength(TARGETS.length);
    expect(contexts.map((c) => c["steps"])).toEqual([1, 2, 3]);
    for (const context of contexts) {
      expect(context["dlqReason"]).toBe(DLQ_REASON);
      expect(context["cursor"]).toBeNull();
      expect(context["resumeAt"]).toBeNull();
    }
  });

  it("stamps a completed_at per execution as an ISO timestamp", async () => {
    const { params } = await render(TARGETS);
    const stamps = params.filter(
      (p): p is string => typeof p === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(p),
    );
    expect(stamps).toHaveLength(TARGETS.length);
  });
});
