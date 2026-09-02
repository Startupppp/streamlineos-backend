import type { RunCompletionDeps } from "../payout-run-completion";
import { checkRunCompletion } from "../payout-run-completion";
import { registerAfterCommit } from "../../../../../common/tenant/tenant-context";
import { PAYROLL_RUN_PAYOUT_POSTING_INTENT_EVENT } from "../../payroll-payout-posting-intent.consumer";

jest.mock("../../../../../common/tenant/tenant-context", () => ({
  registerAfterCommit: jest.fn(),
}));

const mockRegisterAfterCommit = registerAfterCommit as jest.MockedFunction<
  typeof registerAfterCommit
>;

function mkWhere(data: unknown[]) {
  return {
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(data).then(onFulfilled, onRejected),
    limit: jest.fn().mockResolvedValue(data),
  };
}

interface TxRecorder {
  inserted: unknown[];
}

function makeDb(overrides?: { pendingCount?: number; runStatus?: string }) {
  const { pendingCount = 0, runStatus = "PROCESSING" } = overrides ?? {};
  let outerSelectCall = 0;
  const recorder: TxRecorder = { inserted: [] };

  const tx = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest
            .fn()
            .mockResolvedValue([
              { status: runStatus, month: "2026-08", netTotal: "1000000" },
            ]),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((v: unknown) => {
        recorder.inserted.push(v);
        return Promise.resolve([]);
      }),
    }),
  };

  const db = {
    query: {
      payrollBankBatches: {
        findFirst: jest.fn().mockResolvedValue({ runId: 100 }),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    },
    select: jest.fn().mockImplementation(() => {
      const call = outerSelectCall++;
      const data =
        call === 0
          ? [{ id: 1 }]
          : call === 1
            ? Array.from({ length: pendingCount }, (_, i) => ({ id: i + 1 }))
            : [{ runEmployeeId: 50 }];
      return {
        from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue(mkWhere(data)) }),
      };
    }),
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => cb(tx)),
  };

  return { db, recorder };
}

function makeDeps(overrides?: { pendingCount?: number; runStatus?: string }): {
  deps: RunCompletionDeps;
  recorder: TxRecorder;
} {
  const { db, recorder } = makeDb(overrides);
  return {
    deps: {
      db: db as never,
      audit: { log: jest.fn() } as never,
      logger: {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      } as never,
    },
    recorder,
  };
}

function postingIntents(recorder: TxRecorder): Record<string, unknown>[] {
  return recorder.inserted.filter(
    (row): row is Record<string, unknown> =>
      typeof row === "object" &&
      row !== null &&
      !Array.isArray(row) &&
      (row as Record<string, unknown>).eventType ===
        PAYROLL_RUN_PAYOUT_POSTING_INTENT_EVENT,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRegisterAfterCommit.mockReturnValue(true);
});

describe("checkRunCompletion — the paid posting intent commits on the run transaction", () => {
  it("emits exactly one payout posting intent inside the transaction that marks the run PAID", async () => {
    const { deps, recorder } = makeDeps();

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    const intents = postingIntents(recorder);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      organizationId: "org-1",
      aggregateType: "payroll_run",
      aggregateId: "100",
      eventType: PAYROLL_RUN_PAYOUT_POSTING_INTENT_EVENT,
    });
  });

  it("carries the run's month and net total in the payload so the consumer needs no extra read", async () => {
    const { deps, recorder } = makeDeps();

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(postingIntents(recorder)[0]?.payload).toEqual({
      runId: 100,
      month: "2026-08",
      net: "1000000",
      actorUserId: "actor-1",
      orgId: "org-1",
    });
  });

  it("never defers the accounting post to an after-commit hook — only the journal snapshot is deferred", async () => {
    const { deps } = makeDeps();

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(mockRegisterAfterCommit).toHaveBeenCalledTimes(1);
  });

  it("emits no posting intent when pending batch items remain", async () => {
    const { deps, recorder } = makeDeps({ pendingCount: 2 });

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(postingIntents(recorder)).toHaveLength(0);
    expect(mockRegisterAfterCommit).not.toHaveBeenCalled();
  });

  it("emits no posting intent when the run is already PAID, so a replayed completion cannot double-post", async () => {
    const { deps, recorder } = makeDeps({ runStatus: "PAID" });

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(postingIntents(recorder)).toHaveLength(0);
    expect(mockRegisterAfterCommit).not.toHaveBeenCalled();
  });

  it("emits no posting intent when the run is already CLOSED", async () => {
    const { deps, recorder } = makeDeps({ runStatus: "CLOSED" });

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(postingIntents(recorder)).toHaveLength(0);
  });
});
