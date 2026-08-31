import type { RunCompletionDeps } from "../payout-run-completion";
import { checkRunCompletion } from "../payout-run-completion";
import { registerAfterCommit } from "../../../../../common/tenant/tenant-context";

jest.mock("../../../../../common/tenant/tenant-context", () => ({
  registerAfterCommit: jest.fn(),
}));
jest.mock("../../../../../common/auth/system-actor", () => ({
  systemActor: jest.fn().mockReturnValue({ userId: "system", orgId: "org-1" }),
}));

const mockRegisterAfterCommit = registerAfterCommit as jest.MockedFunction<typeof registerAfterCommit>;

type PostPaidFn = RunCompletionDeps["payrollPosting"]["postPaid"];

function mkWhere(data: unknown[]) {
  return {
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(data).then(onFulfilled, onRejected),
    limit: jest.fn().mockResolvedValue(data),
  };
}

function makeDb(overrides?: { pendingCount?: number }) {
  const { pendingCount = 0 } = overrides ?? {};
  let outerSelectCall = 0;

  const tx = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ status: "PROCESSING" }]),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue([]),
    }),
  };

  return {
    query: {
      payrollBankBatches: {
        findFirst: jest.fn().mockResolvedValue({ runId: 100 }),
      },
    },
    select: jest.fn().mockImplementation(() => {
      const call = outerSelectCall++;
      const data =
        call === 0 ? [{ id: 1 }] :
        call === 1 ? Array.from({ length: pendingCount }, (_, i) => ({ id: i + 1 })) :
        call === 2 ? [{ runEmployeeId: 50 }] :
        [{ month: "2026-08", netTotal: "1000000" }];
      return { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue(mkWhere(data)) }) };
    }),
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => cb(tx)),
  };
}

function makeDeps(overrides?: { pendingCount?: number }): RunCompletionDeps {
  return {
    db: makeDb(overrides) as never,
    audit: { log: jest.fn() } as never,
    payrollPosting: { postPaid: jest.fn().mockResolvedValue(undefined) } as never,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRegisterAfterCommit.mockReturnValue(true);
});

describe("checkRunCompletion — postPaid accounting side-effect", () => {
  it("registers postPaid as an after-commit hook and does not call it synchronously", async () => {
    const deps = makeDeps();

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(mockRegisterAfterCommit).toHaveBeenCalledTimes(2);
    expect(deps.payrollPosting.postPaid).not.toHaveBeenCalled();
  });

  it("the registered hook calls postPaid with the correct run data when invoked", async () => {
    let capturedHook: (() => Promise<unknown>) | undefined;
    mockRegisterAfterCommit.mockImplementation((hook) => {
      capturedHook ??= hook;
      return true;
    });
    const deps = makeDeps();

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(capturedHook).toBeDefined();
    await capturedHook!();

    expect(deps.payrollPosting.postPaid).toHaveBeenCalledTimes(1);
    expect(deps.payrollPosting.postPaid).toHaveBeenCalledWith(
      expect.anything(),
      100,
      "2026-08",
      "1000000",
    );
  });

  it("calls postPaid inline when registerAfterCommit returns false (no ambient context)", async () => {
    mockRegisterAfterCommit.mockReturnValue(false);
    const deps = makeDeps();

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(deps.payrollPosting.postPaid).toHaveBeenCalledTimes(1);
    expect(deps.payrollPosting.postPaid).toHaveBeenCalledWith(
      expect.anything(),
      100,
      "2026-08",
      "1000000",
    );
  });

  it("checkRunCompletion resolves even when postPaid would fail (postPaid is deferred, not in-flight)", async () => {
    const deps = makeDeps();
    (deps.payrollPosting.postPaid as jest.MockedFunction<PostPaidFn>).mockRejectedValue(
      new Error("accounting unavailable"),
    );

    await expect(checkRunCompletion(deps, "org-1", 1, "actor-1")).resolves.toBeUndefined();
    expect(deps.payrollPosting.postPaid).not.toHaveBeenCalled();
  });

  it("does not call postPaid or registerAfterCommit when pending batch items remain", async () => {
    const deps = makeDeps({ pendingCount: 2 });

    await checkRunCompletion(deps, "org-1", 1, "actor-1");

    expect(mockRegisterAfterCommit).not.toHaveBeenCalled();
    expect(deps.payrollPosting.postPaid).not.toHaveBeenCalled();
  });
});
