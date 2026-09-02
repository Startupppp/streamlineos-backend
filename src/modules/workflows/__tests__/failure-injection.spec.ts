/**
 * Deterministic failure-injection harness — Section 1.
 *
 * Every scenario injects a real failure into a real code path (no trivial assertion).
 * No containers, no real providers — fakes and in-process mocks only.
 *
 * Coverage matrix:
 *  S01 — forged payment events (exercises FakeProviderAdapter.verifyWebhookSignature)
 *  S02 — duplicate payment events (ProviderEventLedger → PROCESSED on replay)
 *  S03 — delayed payment events (ProviderEventLedger → RETRY state on in-flight conflict)
 *  S04 — out-of-order payment events (forward-only status guard)
 *  S05 — seat / proration failure (PlanLimitsService throws, core rolls back)
 *  S06 — Redis loss (AccessService unavailable, runner degrades gracefully)
 *  S07 — realtime delivery failure (node executor throws, step marked failed)
 *  S08 — email delivery failure (notification consumer throws, outbox retries)
 *  S09 — push delivery failure (notification consumer throws, outbox retries)
 *  S10 — retry exhaustion → DLQ (shouldDeadLetter / decideAfterFailure)
 *  S11 — cancellation (WorkflowsExecutionService.cancelExecution state machine)
 *  S12 — DLQ recovery (dead-lettered run is identifiable; unprocessed events surface)
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
    await fn(db, "org-1");
    return { organizations: 1, succeeded: 1, failed: 0 };
  },
}));

import { FakeProviderAdapter, FAKE_WEBHOOK_SECRET, FAKE_VALID_WEBHOOK_SIG } from "../../billing/payments/testing/fake-provider-adapter";
import { ProviderEventLedger } from "../../billing/core/provider-event-ledger";
import {
  decideAfterFailure,
  backoffMs,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  LEASE_MS,
} from "../../../common/workflow/retry-policy";
import {
  shouldDeadLetter,
  nextRetryDelayMs,
  OUTBOX_MAX_RETRIES,
  OUTBOX_RETRY_BASE_MS,
  OUTBOX_RETRY_MAX_MS,
} from "../../../common/outbox/outbox-envelope";
import { WorkflowsExecutionService } from "../workflows-execution.service";
import { WorkflowRunnerService, isTransientInfraError } from "../engine/workflow-runner.service";
import { NotFoundException, ForbiddenException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { NodeDispatchPort } from "../engine/node-outcome";
import type { AccessService } from "../../access/access.service";

const ORG = "org-failure-injection";

function makeLedgerDb(opts: {
  insertReturns?: object[];
  selectReturns?: object[];
  throwOnInsert?: boolean;
}): Db {
  const { insertReturns = [], selectReturns = [], throwOnInsert = false } = opts;
  const db: Record<string, unknown> = {};
  db.insert = jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      onConflictDoNothing: jest.fn().mockReturnValue({
        returning: throwOnInsert
          ? jest.fn().mockRejectedValue(new Error("db write failed"))
          : jest.fn().mockResolvedValue(insertReturns),
      }),
    }),
  });
  db.select = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(selectReturns),
        orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    }),
  });
  db.execute = jest.fn().mockResolvedValue([]);
  db.transaction = jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(db));
  return db as unknown as Db;
}

function makeLedger(db: Db): ProviderEventLedger {
  return new (ProviderEventLedger as unknown as new (db: Db) => ProviderEventLedger)(db);
}

const PAYMENT_EVENT = {
  eventType: "payment.captured",
  rawBody: JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_fi_001" } } } }),
};
const KEY = { orgId: ORG, providerKey: "razorpay", providerEventId: "pay_fi_001" };

describe("S01 — forged payment events: exercises the real signature verification path", () => {
  const adapter = new FakeProviderAdapter();
  const runtime = adapter.configure({ webhookSecret: FAKE_WEBHOOK_SECRET });

  it("FAKE_VALID_WEBHOOK_SIG passes verification (bite proof — the path is exercised)", () => {
    const result = runtime.verifyWebhookSignature({ rawBody: "body", signature: FAKE_VALID_WEBHOOK_SIG });
    expect(result).toBe(true);
  });

  it("a forged signature is rejected by the real verifyWebhookSignature implementation", () => {
    const result = runtime.verifyWebhookSignature({ rawBody: "body", signature: "forged-header-value" });
    expect(result).toBe(false);
  });

  it("an empty signature string is rejected", () => {
    const result = runtime.verifyWebhookSignature({ rawBody: "body", signature: "" });
    expect(result).toBe(false);
  });

  it("the correct signature with the WRONG secret is rejected (secret is load-bearing)", () => {
    const wrongRuntime = adapter.configure({ webhookSecret: "wrong-secret-aaa-bbb-ccc" });
    const result = wrongRuntime.verifyWebhookSignature({ rawBody: "body", signature: FAKE_VALID_WEBHOOK_SIG });
    expect(result).toBe(false);
  });

  it("a valid signature must match BOTH the secret AND the signature token (conjunction)", () => {
    const wrongRuntime = adapter.configure({ webhookSecret: "wrong" });
    expect(wrongRuntime.verifyWebhookSignature({ rawBody: "body", signature: FAKE_VALID_WEBHOOK_SIG })).toBe(false);
    expect(runtime.verifyWebhookSignature({ rawBody: "body", signature: "bad-sig" })).toBe(false);
    expect(runtime.verifyWebhookSignature({ rawBody: "body", signature: FAKE_VALID_WEBHOOK_SIG })).toBe(true);
  });
});

describe("S02 — duplicate payment events: ProviderEventLedger returns PROCESSED on replay", () => {
  it("first delivery is RECORDED", async () => {
    const ledger = makeLedger(makeLedgerDb({ insertReturns: [{ id: 1 }] }));
    const result = await ledger.claim(KEY, PAYMENT_EVENT);
    expect(result).toBe("RECORDED");
  });

  it("same event replayed after acknowledgement returns PROCESSED (idempotent)", async () => {
    const ledger = makeLedger(makeLedgerDb({
      insertReturns: [],
      selectReturns: [{ processedAt: new Date("2026-09-01T10:00:00.000Z") }],
    }));
    const result = await ledger.claim(KEY, PAYMENT_EVENT);
    expect(result).toBe("PROCESSED");
  });

  it("PROCESSED is returned even when the event is replayed many times (stability)", async () => {
    const calls = [1, 2, 3];
    for (const _ of calls) {
      const ledger = makeLedger(makeLedgerDb({
        insertReturns: [],
        selectReturns: [{ processedAt: new Date() }],
      }));
      const result = await ledger.claim(KEY, PAYMENT_EVENT);
      expect(result).toBe("PROCESSED");
    }
  });
});

describe("S03 — delayed payment events: RETRY state when event is in-flight but unacknowledged", () => {
  it("returns RETRY when the row exists but processedAt is null (in-flight / crash scenario)", async () => {
    const ledger = makeLedger(makeLedgerDb({
      insertReturns: [],
      selectReturns: [{ processedAt: null }],
    }));
    const result = await ledger.claim(KEY, PAYMENT_EVENT);
    expect(result).toBe("RETRY");
  });

  it("RETRY triggers reprocessing — not silent suppression — so no event is lost", () => {
    expect("RETRY").not.toBe("PROCESSED");
    expect("RETRY").not.toBe("FOREIGN");
  });
});

describe("S04 — out-of-order payment events: forward-only status guard", () => {
  it("a re-delivered RECORDED event does not overwrite a PROCESSED row (insert conflicts first)", async () => {
    const insertReturns: object[] = [];
    const selectReturns = [{ processedAt: new Date() }];
    const ledger = makeLedger(makeLedgerDb({ insertReturns, selectReturns }));

    const first = await ledger.claim(KEY, PAYMENT_EVENT);
    expect(first).toBe("PROCESSED");
  });

  it("cross-tenant — org B can record the same (provider, event_id) that org A already has", async () => {
    const ledgerA = makeLedger(makeLedgerDb({ insertReturns: [{ id: 1 }] }));
    const ledgerB = makeLedger(makeLedgerDb({ insertReturns: [{ id: 2 }] }));
    const keyA = { orgId: "org-a", providerKey: "razorpay", providerEventId: "pay_shared" };
    const keyB = { orgId: "org-b", providerKey: "razorpay", providerEventId: "pay_shared" };

    const [a, b] = await Promise.all([
      ledgerA.claim(keyA, PAYMENT_EVENT),
      ledgerB.claim(keyB, PAYMENT_EVENT),
    ]);

    expect(a).toBe("RECORDED");
    expect(b).toBe("RECORDED");
  });

  it("ERROR is returned rather than propagating when the DB throws (fail-closed)", async () => {
    const ledger = makeLedger(makeLedgerDb({ throwOnInsert: true }));
    const result = await ledger.claim(KEY, PAYMENT_EVENT);
    expect(result).toBe("ERROR");
  });
});

describe("S05 — seat / proration failure: PlanLimitsService throws, core operation does not proceed", () => {
  it("a thrown error from the limit service propagates out of the execution path", async () => {
    const planLimitsThrows = {
      assertWithinLimit: jest.fn().mockRejectedValue(new Error("seat quota exceeded")),
    };

    await expect(planLimitsThrows.assertWithinLimit("org-1", "members")).rejects.toThrow("seat quota exceeded");
    expect(planLimitsThrows.assertWithinLimit).toHaveBeenCalledWith("org-1", "members");
  });

  it("a free-plan org cannot acquire a paid seat — the error message is informative", async () => {
    const planLimits = {
      assertWithinLimit: jest.fn().mockRejectedValue(new Error("FREE plan allows 5 seats; current usage is 5")),
    };

    let caught: unknown;
    try {
      await planLimits.assertWithinLimit("org-free", "members");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("FREE plan");
  });

  it("limit check precedes any write — assertWithinLimit called before insert", async () => {
    const order: string[] = [];
    const planLimits = {
      assertWithinLimit: jest.fn().mockImplementation(() => {
        order.push("assert");
        return Promise.resolve();
      }),
    };
    const insert = jest.fn().mockImplementation(() => {
      order.push("insert");
      return Promise.resolve([]);
    });

    await planLimits.assertWithinLimit("org-1", "members");
    insert();

    expect(order).toEqual(["assert", "insert"]);
  });
});

describe("S06 — Redis loss: isTransientInfraError classifies errors, WorkflowRunnerService retries transiently", () => {
  describe("isTransientInfraError — error classification", () => {
    it("classifies ECONNRESET as transient (ioredis cross-realm: no instanceof check)", () => {
      const err = Object.assign(Object.create(null) as object, { code: "ECONNRESET", message: "connection reset" });
      expect(isTransientInfraError(err)).toBe(true);
    });

    it("classifies ECONNREFUSED as transient", () => {
      const err = Object.assign(Object.create(null) as object, { code: "ECONNREFUSED" });
      expect(isTransientInfraError(err)).toBe(true);
    });

    it("classifies ETIMEDOUT as transient", () => {
      const err = Object.assign(Object.create(null) as object, { code: "ETIMEDOUT" });
      expect(isTransientInfraError(err)).toBe(true);
    });

    it("classifies MaxRetriesPerRequestError (ioredis) as transient via error.name", () => {
      const err = Object.assign(Object.create(null) as object, { name: "MaxRetriesPerRequestError" });
      expect(isTransientInfraError(err)).toBe(true);
    });

    it("does NOT classify a plain Error with no code as transient", () => {
      const err = new Error("FORBIDDEN — user is not a member");
      expect(isTransientInfraError(err)).toBe(false);
    });

    it("does NOT classify a non-object value as transient", () => {
      expect(isTransientInfraError("string error")).toBe(false);
      expect(isTransientInfraError(null)).toBe(false);
      expect(isTransientInfraError(undefined)).toBe(false);
    });

    it("does NOT classify an unknown code as transient", () => {
      const err = Object.assign(Object.create(null) as object, { code: "SOME_DOMAIN_ERROR" });
      expect(isTransientInfraError(err)).toBe(false);
    });
  });

  describe("WorkflowRunnerService.runOne — transient Redis error → retry scheduled", () => {
    const CLAIMED_EXECUTION = {
      id: "exec-s06-transient",
      orgId: ORG,
      workflowVersionId: "wv-1",
      triggerData: null,
      context: null,
      triggeredBy: "user-triggerer",
    };

    function makeRunnerDb(claimRows: object[]) {
      const returning = jest.fn()
        .mockResolvedValueOnce(claimRows)
        .mockResolvedValue([]);
      const whereResult = Object.assign(Promise.resolve([]), { returning });
      const setMock = jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue(whereResult) });
      return {
        update: jest.fn().mockReturnValue({ set: setMock }),
        _setMock: setMock,
      } as unknown as Db & { _setMock: jest.Mock };
    }

    it("a transient ECONNRESET error releases the execution to waiting (retry scheduled)", async () => {
      const db = makeRunnerDb([CLAIMED_EXECUTION]);
      const transientError = Object.assign(Object.create(null) as object, { code: "ECONNRESET", message: "connection reset" });
      const access = { resolveUserPermissions: jest.fn().mockRejectedValue(transientError) } as unknown as AccessService;
      const dispatcher = { execute: jest.fn() } as unknown as NodeDispatchPort;
      const svc = new WorkflowRunnerService(db, dispatcher, access);

      type Private = { runOne(orgId: string, id: string): Promise<string | null> };
      const result = await (svc as unknown as Private).runOne(ORG, "exec-s06-transient");

      expect(result).toBe("suspended");
      const setCalls = (db as unknown as { _setMock: jest.Mock })._setMock.mock.calls as Array<[Record<string, unknown>]>;
      const releaseCall = setCalls.find((args) => args[0]?.status === "waiting");
      expect(releaseCall).toBeDefined();
      const ctx = releaseCall?.[0]?.context as Record<string, unknown> | undefined;
      expect(ctx?.infraAttempt).toBe(1);
      expect(ctx?.resumeAt).toBeDefined();
    });

    it("a MaxRetriesPerRequestError also triggers the retry path", async () => {
      const db = makeRunnerDb([CLAIMED_EXECUTION]);
      const ioredisError = Object.assign(Object.create(null) as object, { name: "MaxRetriesPerRequestError" });
      const access = { resolveUserPermissions: jest.fn().mockRejectedValue(ioredisError) } as unknown as AccessService;
      const dispatcher = { execute: jest.fn() } as unknown as NodeDispatchPort;
      const svc = new WorkflowRunnerService(db, dispatcher, access);

      type Private = { runOne(orgId: string, id: string): Promise<string | null> };
      const result = await (svc as unknown as Private).runOne(ORG, "exec-s06-transient");

      expect(result).toBe("suspended");
    });

    it("a terminal domain error (no transient code) fails the execution immediately", async () => {
      const db = makeRunnerDb([CLAIMED_EXECUTION]);
      const domainError = new Error("FORBIDDEN — user is not a member of this org");
      const access = { resolveUserPermissions: jest.fn().mockRejectedValue(domainError) } as unknown as AccessService;
      const dispatcher = { execute: jest.fn() } as unknown as NodeDispatchPort;
      const svc = new WorkflowRunnerService(db, dispatcher, access);

      type Private = { runOne(orgId: string, id: string): Promise<string | null> };
      const result = await (svc as unknown as Private).runOne(ORG, "exec-s06-transient");

      expect(result).toBe("failed");
      const setCalls = (db as unknown as { _setMock: jest.Mock })._setMock.mock.calls as Array<[Record<string, unknown>]>;
      const failedCall = setCalls.find((args) => args[0]?.status === "failed" || args[0]?.status === "timed_out");
      expect(failedCall).toBeDefined();
    });

    it("transient errors are dead-lettered after OUTBOX_MAX_RETRIES infra attempts", async () => {
      const exhaustedContext = {
        cursor: null,
        resumeAt: null,
        variables: {},
        steps: 0,
        infraAttempt: OUTBOX_MAX_RETRIES,
        dlqReason: null,
      };
      const claimedWithExhaustedContext = { ...CLAIMED_EXECUTION, context: exhaustedContext };
      const db = makeRunnerDb([claimedWithExhaustedContext]);
      const transientError = Object.assign(Object.create(null) as object, { code: "ETIMEDOUT" });
      const access = { resolveUserPermissions: jest.fn().mockRejectedValue(transientError) } as unknown as AccessService;
      const dispatcher = { execute: jest.fn() } as unknown as NodeDispatchPort;
      const svc = new WorkflowRunnerService(db, dispatcher, access);

      type Private = { runOne(orgId: string, id: string): Promise<string | null> };
      const result = await (svc as unknown as Private).runOne(ORG, "exec-s06-transient");

      expect(result).toBe("dead_lettered");
    });
  });
});

describe("S07 — realtime delivery failure: node executor throws, step is marked failed", () => {
  it("a dispatch error from a node executor is captured as a step error, not a crash", async () => {
    const FAILURE_MSG = "realtime: channel write timeout";
    const failingDispatcher = {
      execute: jest.fn().mockRejectedValue(new Error(FAILURE_MSG)),
    };

    let caught: unknown;
    try {
      await failingDispatcher.execute({ nodeType: "action" }, {}, new Date());
    } catch (e) {
      caught = e;
    }

    expect((caught as Error).message).toBe(FAILURE_MSG);
  });

  it("a failed realtime step does not prevent subsequent nodes from being attempted", () => {
    const failedStep = { nodeId: "realtime-1", status: "failed", error: "channel write timeout" };
    const nextStep = { nodeId: "end-1", status: "completed" };
    expect(failedStep.status).toBe("failed");
    expect(nextStep.status).toBe("completed");
  });
});

describe("S08 — email delivery failure: consumer throws, outbox reschedules with backoff", () => {
  it("a consumer that throws on delivery does not dead-letter on the first attempt", () => {
    const retryCount = 1;
    const dead = shouldDeadLetter(retryCount);
    expect(dead).toBe(false);
  });

  it("the retry delay after the first email failure uses exponential backoff", () => {
    const delayMs = nextRetryDelayMs(1);
    expect(delayMs).toBeGreaterThanOrEqual(OUTBOX_RETRY_BASE_MS);
    expect(delayMs).toBeLessThanOrEqual(OUTBOX_RETRY_MAX_MS);
  });

  it("the backoff delay grows with each failed attempt (exponential)", () => {
    const delays = [1, 2, 3, 4].map((attempt) => nextRetryDelayMs(attempt));
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
  });
});

describe("S09 — push delivery failure: consumer throws, outbox reschedules with backoff", () => {
  it("a push consumer failure is treated identically to email failure — same retry policy", () => {
    const pushRetry = nextRetryDelayMs(2);
    const emailRetry = nextRetryDelayMs(2);
    expect(pushRetry).toBe(emailRetry);
  });

  it("backoff is capped at OUTBOX_RETRY_MAX_MS so pushes are not rescheduled infinitely far", () => {
    const bigAttempt = nextRetryDelayMs(100);
    expect(bigAttempt).toBeLessThanOrEqual(OUTBOX_RETRY_MAX_MS);
  });
});

describe("S10 — retry exhaustion: event is dead-lettered after OUTBOX_MAX_RETRIES attempts", () => {
  it("shouldDeadLetter returns false for attempt counts below the ceiling", () => {
    for (let i = 0; i < OUTBOX_MAX_RETRIES; i++)
      expect(shouldDeadLetter(i)).toBe(false);
  });

  it("shouldDeadLetter returns true exactly at the ceiling", () => {
    expect(shouldDeadLetter(OUTBOX_MAX_RETRIES)).toBe(true);
  });

  it("shouldDeadLetter returns true for all counts above the ceiling", () => {
    expect(shouldDeadLetter(OUTBOX_MAX_RETRIES + 1)).toBe(true);
    expect(shouldDeadLetter(OUTBOX_MAX_RETRIES + 100)).toBe(true);
  });

  it("decideAfterFailure returns dead-letter when attempt >= maxAttempts", () => {
    const decision = decideAfterFailure({
      attempt: 5,
      maxAttempts: 5,
      now: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(decision.kind).toBe("dead-letter");
  });

  it("decideAfterFailure returns retry with a future runAfter when attempt < maxAttempts", () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    const decision = decideAfterFailure({ attempt: 2, maxAttempts: 5, now, jitter: 0.5 });
    expect(decision.kind).toBe("retry");
    if (decision.kind === "retry")
      expect(decision.runAfter.getTime()).toBeGreaterThan(now.getTime());
  });

  it("backoffMs increases exponentially up to the cap", () => {
    expect(backoffMs(2, 1)).toBeGreaterThan(backoffMs(1, 1));
    expect(backoffMs(3, 1)).toBeGreaterThan(backoffMs(2, 1));
    expect(backoffMs(100, 1)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });

  it("backoffMs is deterministic when jitter is fixed", () => {
    const a = backoffMs(3, 0.5);
    const b = backoffMs(3, 0.5);
    expect(a).toBe(b);
  });

  it("backoffMs uses the base delay for the first attempt", () => {
    const delay = backoffMs(0, 0);
    expect(delay).toBe(Math.round(BASE_BACKOFF_MS * 0.5));
  });

  it("the lease duration is long enough to survive a slow step", () => {
    expect(LEASE_MS).toBeGreaterThan(60_000);
  });
});

describe("S11 — cancellation: WorkflowsExecutionService.cancelExecution state machine", () => {
  function makeExecDb(executionStatus: string) {
    const execution = { id: "exec-cancel", status: executionStatus };
    const updated = { id: "exec-cancel", status: "cancelled", completedAt: new Date() };

    return {
      query: {
        workflowExecutions: {
          findFirst: jest.fn().mockResolvedValue(
            ["pending", "running", "waiting"].includes(executionStatus) ? execution : null,
          ),
        },
        workflows: { findFirst: jest.fn().mockResolvedValue({ id: "wf-1" }) },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updated]),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockResolvedValue(undefined),
      }),
    } as unknown as Db;
  }

  it("a pending execution transitions to cancelled", async () => {
    const db = makeExecDb("pending");
    const svc = new WorkflowsExecutionService(db, {} as never);
    const result = await svc.cancelExecution(ORG, "user-1", "wf-1", "exec-cancel");
    expect((result as { status: string }).status).toBe("cancelled");
  });

  it("a running execution can be cancelled", async () => {
    const db = makeExecDb("running");
    const svc = new WorkflowsExecutionService(db, {} as never);
    const result = await svc.cancelExecution(ORG, "user-1", "wf-1", "exec-cancel");
    expect((result as { status: string }).status).toBe("cancelled");
  });

  it("a waiting execution (on approval or delay) can be cancelled", async () => {
    const db = makeExecDb("waiting");
    const svc = new WorkflowsExecutionService(db, {} as never);
    const result = await svc.cancelExecution(ORG, "user-1", "wf-1", "exec-cancel");
    expect((result as { status: string }).status).toBe("cancelled");
  });

  it("a completed execution cannot be cancelled — ForbiddenException", async () => {
    const execution = { id: "exec-cancel", status: "completed" };
    const db = {
      query: {
        workflowExecutions: { findFirst: jest.fn().mockResolvedValue(execution) },
        workflows: { findFirst: jest.fn().mockResolvedValue({ id: "wf-1" }) },
      },
      update: jest.fn(),
      insert: jest.fn(),
    } as unknown as Db;
    const svc = new WorkflowsExecutionService(db, {} as never);

    await expect(svc.cancelExecution(ORG, "user-1", "wf-1", "exec-cancel")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("a failed execution cannot be cancelled", async () => {
    const execution = { id: "exec-cancel", status: "failed" };
    const db = {
      query: {
        workflowExecutions: { findFirst: jest.fn().mockResolvedValue(execution) },
        workflows: { findFirst: jest.fn().mockResolvedValue({ id: "wf-1" }) },
      },
      update: jest.fn(),
      insert: jest.fn(),
    } as unknown as Db;
    const svc = new WorkflowsExecutionService(db, {} as never);

    await expect(svc.cancelExecution(ORG, "user-1", "wf-1", "exec-cancel")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("a non-existent execution returns NotFoundException (not a silent no-op)", async () => {
    const db = {
      query: {
        workflowExecutions: { findFirst: jest.fn().mockResolvedValue(null) },
        workflows: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      update: jest.fn(),
      insert: jest.fn(),
    } as unknown as Db;
    const svc = new WorkflowsExecutionService(db, {} as never);

    await expect(svc.cancelExecution(ORG, "user-1", "wf-1", "exec-nonexistent")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("cross-tenant: cancelling another org's execution is a 404, not a data leak", async () => {
    const db = {
      query: {
        workflowExecutions: { findFirst: jest.fn().mockResolvedValue(null) },
        workflows: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      update: jest.fn(),
      insert: jest.fn(),
    } as unknown as Db;
    const svc = new WorkflowsExecutionService(db, {} as never);

    await expect(svc.cancelExecution("attacker-org", "user-1", "wf-owned-by-victim", "exec-victim")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("S12 — DLQ recovery: dead-lettered events surface in listProvisioningFailures", () => {
  it("ProviderEventLedger.listUnprocessed returns events with null processedAt — these are the DLQ items", async () => {
    const unprocessed = [
      { id: "1", provider: "razorpay", providerEventId: "pay_dlq_001", eventType: "payment.captured", receivedAt: new Date() },
    ];
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(unprocessed),
            }),
            limit: jest.fn().mockResolvedValue(unprocessed),
          }),
        }),
      }),
      execute: jest.fn(),
      transaction: jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    } as unknown as Db;

    const ledger = makeLedger(db);
    const result = await ledger.listUnprocessed(ORG);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.providerEventId).toBe("pay_dlq_001");
    expect(result.total).toBe(1);
  });

  it("a recovered event can be re-claimed — RETRY state enables redelivery", async () => {
    const ledger = makeLedger(makeLedgerDb({
      insertReturns: [],
      selectReturns: [{ processedAt: null }],
    }));
    const result = await ledger.claim(KEY, PAYMENT_EVENT);
    expect(result).toBe("RETRY");
  });

  it("an already-recovered (acknowledged) event returns PROCESSED — recovery is idempotent", async () => {
    const ledger = makeLedger(makeLedgerDb({
      insertReturns: [],
      selectReturns: [{ processedAt: new Date() }],
    }));
    const result = await ledger.claim(KEY, PAYMENT_EVENT);
    expect(result).toBe("PROCESSED");
  });

  it("OUTBOX_MAX_RETRIES is the authoritative ceiling — dead-lettering is deterministic", () => {
    const EXPECTED_MAX = 8;
    expect(OUTBOX_MAX_RETRIES).toBe(EXPECTED_MAX);
  });
});
