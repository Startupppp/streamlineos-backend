jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: async <T>(db: unknown, _orgId: string, fn: (tx: unknown) => Promise<T>) => fn(db),
}));

import { ProviderEventLedger } from "./provider-event-ledger";

const EVENT = { eventType: "payment.captured", rawBody: '{"event":"payment.captured"}' };

type MockDb = ReturnType<typeof buildDb>;

function buildDb(insertReturns: object[], selectReturns: object[]) {
  const db: Record<string, unknown> = {};
  db.insert = jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      onConflictDoNothing: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(insertReturns),
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
  return db;
}

function makeLedger(db: MockDb): ProviderEventLedger {
  return new (ProviderEventLedger as unknown as new (db: unknown) => ProviderEventLedger)(db);
}

describe("ProviderEventLedger — claim()", () => {
  it("returns RECORDED when the insert succeeds", async () => {
    const ledger = makeLedger(buildDb([{ id: 1 }], []));

    const result = await ledger.claim({ orgId: "org_a", providerKey: "razorpay", providerEventId: "pay_001" }, EVENT);

    expect(result).toBe("RECORDED");
  });

  it("returns RETRY when the insert conflicts and the row has no processedAt", async () => {
    const ledger = makeLedger(buildDb([], [{ processedAt: null }]));

    const result = await ledger.claim({ orgId: "org_a", providerKey: "razorpay", providerEventId: "pay_001" }, EVENT);

    expect(result).toBe("RETRY");
  });

  it("returns PROCESSED when the insert conflicts and the row is already acknowledged", async () => {
    const ledger = makeLedger(buildDb([], [{ processedAt: new Date("2026-01-01") }]));

    const result = await ledger.claim({ orgId: "org_a", providerKey: "razorpay", providerEventId: "pay_001" }, EVENT);

    expect(result).toBe("PROCESSED");
  });

  it("returns ERROR and does not propagate when the db throws", async () => {
    const db = buildDb([], []);
    (db.insert as jest.Mock).mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue(new Error("connection reset")),
        }),
      }),
    });
    const ledger = makeLedger(db);

    const result = await ledger.claim({ orgId: "org_a", providerKey: "razorpay", providerEventId: "pay_001" }, EVENT);

    expect(result).toBe("ERROR");
  });

  it("two different orgs can each claim the same (provider, event_id) — the composite index does not cross-tenant block", async () => {
    // With the old global index (provider, provider_event_id) Org B's insert would
    // conflict with Org A's row even though their org_id differs. With the new
    // (org_id, provider, provider_event_id) index each org's space is independent.
    const ledgerA = makeLedger(buildDb([{ id: 1 }], []));
    const ledgerB = makeLedger(buildDb([{ id: 2 }], []));

    const resultA = await ledgerA.claim({ orgId: "org_a", providerKey: "razorpay", providerEventId: "pay_shared" }, EVENT);
    const resultB = await ledgerB.claim({ orgId: "org_b", providerKey: "razorpay", providerEventId: "pay_shared" }, EVENT);

    expect(resultA).toBe("RECORDED");
    expect(resultB).toBe("RECORDED");
  });

  it("conflict target includes org_id so a same-org duplicate is caught, not a cross-org one", async () => {
    const db = buildDb([{ id: 1 }], []);
    const ledger = makeLedger(db);

    await ledger.claim({ orgId: "org_a", providerKey: "razorpay", providerEventId: "pay_001" }, EVENT);

    const onConflictArgs = (
      (db.insert as jest.Mock).mock.results[0]?.value
        .values.mock.results[0]?.value
        .onConflictDoNothing as jest.Mock
    ).mock.calls[0]?.[0] as { target: unknown[] } | undefined;

    expect(onConflictArgs?.target).toHaveLength(3);
  });
});
