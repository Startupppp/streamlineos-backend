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
  updates: { table: unknown; values: Record<string, unknown> }[];
}

interface DbOverrides {
  /** distinct payees carrying a bank instruction on this run */
  subjects?: number;
  /** distinct payees whose instruction settled PAID */
  paidSubjects?: number;
  /**
   * Run payees who are owed money and are not on hold — the set a completed
   * run must have covered. Defaults to `paidSubjects`, i.e. a run where the
   * batch reached everyone.
   */
  payable?: number;
  runStatus?: string;
  /** Integer paise actually disbursed, as the aggregate returns it (text). */
  paidNetPaise?: string;
}

function makeDb(overrides?: DbOverrides) {
  const {
    subjects = 1,
    paidSubjects = 1,
    payable = paidSubjects,
    runStatus = "PROCESSING",
    paidNetPaise = "100000000",
  } = overrides ?? {};
  let outerSelectCall = 0;
  const recorder: TxRecorder = { inserted: [], updates: [] };

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
        innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({}) }),
      }),
    }),
    update: jest.fn().mockImplementation((table: unknown) => ({
      set: jest.fn().mockImplementation((values: Record<string, unknown>) => {
        recorder.updates.push({ table, values });
        return { where: jest.fn().mockResolvedValue([]) };
      }),
    })),
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
    // The reads checkRunCompletion issues, in order: the run's batches, the
    // batched coverage aggregate, the run's payable-payee count, the paid
    // instruction ids, and the paise those paid payees are owed.
    select: jest.fn().mockImplementation(() => {
      const call = outerSelectCall++;
      const data =
        call === 0
          ? [{ id: 1 }]
          : call === 1
            ? [{ subjects, paidSubjects }]
            : call === 2
              ? [{ payable }]
              : call === 3
                ? Array.from({ length: paidSubjects }, (_, i) => ({ runEmployeeId: 50 + i }))
                : [{ totalPaise: paidNetPaise }];
      return {
        from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue(mkWhere(data)) }),
      };
    }),
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => cb(tx)),
  };

  return { db, recorder };
}

function makeDeps(overrides?: DbOverrides): {
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

  it("carries the run's month and the disbursed net in the payload so the consumer needs no extra read", async () => {
    const { deps, recorder } = makeDeps();

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(postingIntents(recorder)[0]?.payload).toEqual({
      runId: 100,
      month: "2026-08",
      net: "1000000.00",
      actorUserId: "actor-1",
      orgId: "org-1",
    });
  });

  it("posts what the bank moved, not the run's net total, when a payee is held back", async () => {
    // Nine of ten payees settle; the tenth is on hold, so the run's ₹1,000,000
    // net total overstates the disbursement by that payee's ₹100,000. Posting
    // the run total would credit BANK_CLEARING for money that never moved and
    // write off a payable that is still owed.
    const { deps, recorder } = makeDeps({
      subjects: 9,
      paidSubjects: 9,
      payable: 9,
      paidNetPaise: "90000000",
    });

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    const intents = postingIntents(recorder);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.payload).toMatchObject({ net: "900000.00" });
  });

  it("never marks the run PAID while a payee who is owed money never reached a batch", async () => {
    // Every instruction settled — but the batch only ever held nine of the ten
    // payees the run owes, and the missing one is not on hold.
    const { deps, recorder } = makeDeps({ subjects: 9, paidSubjects: 9, payable: 10 });

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(postingIntents(recorder)).toHaveLength(0);
    expect(mockRegisterAfterCommit).not.toHaveBeenCalled();
  });

  it("records the disbursed net beside the run's net total on the MARKED_PAID event", async () => {
    const { deps, recorder } = makeDeps({
      subjects: 9,
      paidSubjects: 9,
      payable: 9,
      paidNetPaise: "90000000",
    });

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    const markedPaid = recorder.inserted.find(
      (row): row is Record<string, unknown> =>
        typeof row === "object" &&
        row !== null &&
        !Array.isArray(row) &&
        (row as Record<string, unknown>).type === "MARKED_PAID",
    );
    expect(markedPaid?.metadata).toEqual({
      paidCount: 9,
      payableCount: 9,
      netDisbursed: "900000.00",
      netTotal: "1000000",
    });
  });

  it("never defers the accounting post to an after-commit hook — only the journal snapshot is deferred", async () => {
    const { deps } = makeDeps();

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(mockRegisterAfterCommit).toHaveBeenCalledTimes(1);
  });

  it("emits no posting intent when pending batch items remain", async () => {
    const { deps, recorder } = makeDeps({ subjects: 3, paidSubjects: 1 });

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(postingIntents(recorder)).toHaveLength(0);
    expect(mockRegisterAfterCommit).not.toHaveBeenCalled();
  });

  it("never marks the run PAID when every bank item FAILED — nobody was actually paid", async () => {
    const { deps, recorder } = makeDeps({ subjects: 4, paidSubjects: 0 });

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(postingIntents(recorder)).toHaveLength(0);
    expect(mockRegisterAfterCommit).not.toHaveBeenCalled();
  });

  it("never marks the run PAID while one payee's payment failed and was not re-issued", async () => {
    const { deps, recorder } = makeDeps({ subjects: 3, paidSubjects: 2 });

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(postingIntents(recorder)).toHaveLength(0);
  });

  it("marks the run PAID once a failed payee is re-issued and the retry is paid", async () => {
    const { deps, recorder } = makeDeps({ subjects: 3, paidSubjects: 3 });

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(postingIntents(recorder)).toHaveLength(1);
  });

  it("emits no posting intent when the run has no bank items at all", async () => {
    const { deps, recorder } = makeDeps({ subjects: 0, paidSubjects: 0 });

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(postingIntents(recorder)).toHaveLength(0);
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

describe("checkRunCompletion — reimbursements are stamped paid at payout", () => {
  it("stamps the run's reimbursements paidAt in the transaction that marks the run PAID", async () => {
    const { reimbursements } = jest.requireActual("../../../../../db/schema");
    const { deps, recorder } = makeDeps();

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    const stamp = recorder.updates.find((u) => u.table === reimbursements);
    expect(stamp?.values.paidAt).toBeInstanceOf(Date);
  });

  it("stamps nothing when the run does not reach PAID", async () => {
    const { reimbursements } = jest.requireActual("../../../../../db/schema");
    const { deps, recorder } = makeDeps({ runStatus: "PAID" });

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(recorder.updates.find((u) => u.table === reimbursements)).toBeUndefined();
  });
});
