import { ExternalEffectLeaseBusyError, ExternalEffectLedger } from "./external-effect-ledger";

const runInNewTenantTransaction = jest.fn();
jest.mock("../tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (...args: unknown[]) => runInNewTenantTransaction(...args),
}));

type State = "PENDING" | "IN_FLIGHT" | "SUCCEEDED" | "FAILED";

function makeHarness(
  initial?: { state: State; expired?: boolean },
  options: { loseCompletionLease?: boolean } = {},
) {
  const row: { state?: State; token?: string; uncertain: number; error?: string | null } = {
    state: initial?.state,
    uncertain: 0,
  };
  let updatePatch: Record<string, unknown> = {};
  const tx = {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockImplementation(async () => {
          if (!row.state) row.state = "PENDING";
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((patch: Record<string, unknown>) => {
        updatePatch = patch;
        return {
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockImplementation(async () => {
              if (patch.state === "IN_FLIGHT") {
                const claimable = row.state === "PENDING" || row.state === "FAILED" ||
                  (row.state === "IN_FLIGHT" && initial?.expired);
                if (!claimable) return [];
                if (row.state === "IN_FLIGHT") row.uncertain++;
                row.state = "IN_FLIGHT";
                row.token = patch.attemptToken as string;
                return [{ id: 1 }];
              }
              if (options.loseCompletionLease || row.state !== "IN_FLIGHT" || !row.token) return [];
              row.state = patch.state as State;
              row.error = patch.lastError as string | null;
              row.token = undefined;
              return [{ id: 1 }];
            }),
          }),
        };
      }),
    }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockImplementation(async () => [{ state: row.state }]) }),
      }),
    }),
  };
  runInNewTenantTransaction.mockImplementation(async (_db, _org, fn) => fn(tx));
  return { ledger: new ExternalEffectLedger({} as never), row, get lastPatch() { return updatePatch; } };
}

const effect = {
  organizationId: "org-1",
  producerEventId: "event-1",
  effectKey: "event-1:push",
  effectType: "chat.push",
  providerIdempotency: "STABLE_KEY_PROPAGATED" as const,
};

beforeEach(() => jest.clearAllMocks());

describe("ExternalEffectLedger", () => {
  it("reports an undeployed ledger without querying tenant rows", async () => {
    const db = { execute: jest.fn().mockResolvedValue([{ deployed: false }]) };

    await expect(new ExternalEffectLedger(db as never).report()).resolves.toEqual({
      deployed: false,
      organizations: 0,
      succeeded: 0,
      failed: 0,
      totalRows: 0,
      pending: 0,
      inFlight: 0,
      succeededEffects: 0,
      failedEffects: 0,
      uncertainRetries: 0,
      providerEnforcedEffects: 0,
      stableKeyOnlyEffects: 0,
      noProviderIdempotencyEffects: 0,
    });
  });

  it("records success and suppresses a later replay", async () => {
    const harness = makeHarness();
    const send = jest.fn().mockResolvedValue(undefined);

    await expect(harness.ledger.execute(effect, send)).resolves.toBe("EXECUTED");
    await expect(harness.ledger.execute(effect, send)).resolves.toBe("ALREADY_SUCCEEDED");

    expect(send).toHaveBeenCalledTimes(1);
    expect(harness.row.state).toBe("SUCCEEDED");
  });

  it("records a provider failure and permits a retry", async () => {
    const harness = makeHarness();
    const send = jest.fn()
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce(undefined);

    await expect(harness.ledger.execute(effect, send)).rejects.toThrow("provider down");
    expect(harness.row.state).toBe("FAILED");
    await expect(harness.ledger.execute(effect, send)).resolves.toBe("EXECUTED");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not run concurrently while another attempt owns a live lease", async () => {
    const harness = makeHarness({ state: "IN_FLIGHT" });
    const send = jest.fn();
    await expect(harness.ledger.execute(effect, send)).rejects.toBeInstanceOf(ExternalEffectLeaseBusyError);
    expect(send).not.toHaveBeenCalled();
  });

  it("reclaims an expired attempt and records the uncertain crash-window retry", async () => {
    const harness = makeHarness({ state: "IN_FLIGHT", expired: true });
    await expect(harness.ledger.execute(effect, jest.fn().mockResolvedValue(undefined))).resolves.toBe("EXECUTED");
    expect(harness.row.uncertain).toBe(1);
    expect(harness.row.state).toBe("SUCCEEDED");
  });

  it("fails closed when completion loses the lease after the provider call", async () => {
    const harness = makeHarness(undefined, { loseCompletionLease: true });
    const send = jest.fn().mockResolvedValue(undefined);

    await expect(harness.ledger.execute(effect, send)).rejects.toThrow(
      "lost its lease before completion was recorded",
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(harness.row.state).toBe("IN_FLIGHT");
  });
});
