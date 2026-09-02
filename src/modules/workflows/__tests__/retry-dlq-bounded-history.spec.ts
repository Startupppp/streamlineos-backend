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
  finishExecution: jest.fn().mockResolvedValue(undefined),
  MAX_STEPS_PER_EXECUTION: 200,
}));

import { WorkflowRunnerService, isTransientInfraError } from "../engine/workflow-runner.service";
import { advanceExecution, deadLetterExecution, finishExecution } from "../engine/execution-advance";
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
  (finishExecution as jest.Mock).mockResolvedValue(undefined);
});

// ──────────────────────────────────────────────────────────────────────────────
// Group A — Infrastructure failure retries; deterministic failure does not
// ──────────────────────────────────────────────────────────────────────────────

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
    expect(finishExecution).toHaveBeenCalledWith(expect.anything(), BASE_EXECUTION.id, "failed");
  });

  it("isTransientInfraError returns false for a plain domain Error (no code)", () => {
    expect(isTransientInfraError(new Error("some domain failure"))).toBe(false);
  });

  it("isTransientInfraError returns true for ECONNRESET cross-realm object (no prototype)", () => {
    const err = Object.assign(Object.create(null) as object, { code: "ECONNRESET" });
    expect(isTransientInfraError(err)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Group B — Exhausted retry budget → dead_lettered state with reason preserved
// ──────────────────────────────────────────────────────────────────────────────

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
    expect(finishExecution).toHaveBeenCalledWith(expect.anything(), BASE_EXECUTION.id, "failed");
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

// ──────────────────────────────────────────────────────────────────────────────
// Group C — Step history is bounded: sweep prunes old terminal-execution steps
// ──────────────────────────────────────────────────────────────────────────────

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
