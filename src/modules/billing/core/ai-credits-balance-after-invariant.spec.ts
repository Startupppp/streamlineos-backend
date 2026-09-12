jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async <T>(_db: unknown, fn: (tx: unknown) => Promise<T>, _opts?: unknown) => fn(_db),
}));

import { Test } from "@nestjs/testing";
import { DrizzleQueryError, SQL, is } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AiCreditsService } from "./ai-credits.service";
import { AiCreditsReservationService } from "./ai-credits-reservation.service";
import { AiCreditsPacksService } from "./ai-credits-packs.service";
import { creditsToMilli, milliToCredits } from "../../ai/core/billing/ai-model-pricing.constants";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../../test/postgres-error-fixture";

const PACK = {
  id: 7,
  name: "Invariant Pack",
  credits: 1000,
  bonusCredits: 200,
  priceInPaise: 99900,
  isActive: true,
  sortOrder: 1,
  createdAt: new Date(),
};
const PACK_MILLI = creditsToMilli(PACK.credits + PACK.bonusCredits);

async function buildSvc(db: unknown): Promise<AiCreditsService> {
  const module = await Test.createTestingModule({
    providers: [
      AiCreditsService,
      { provide: DRIZZLE, useValue: db },
      { provide: AiCreditsReservationService, useValue: {} },
      { provide: AiCreditsPacksService, useValue: {} },
    ],
  }).compile();
  return module.get(AiCreditsService);
}

function makeSelectForResult(rows: unknown[]) {
  const p = Promise.resolve(rows);
  return Object.assign(p, { for: () => p, limit: () => p });
}

function makeSelectChain(rows: unknown[]) {
  const forOrLimit = makeSelectForResult(rows);
  return {
    from: () => ({ where: () => forOrLimit }),
  };
}


type WalletCapture = {
  walletBalance: number | null;
  txAmount?: number | null;
  txBalanceAfter: number | null;
  conflictSetBalance?: unknown;
  insertedBalance?: number | null;
};

/**
 * `insert(...).values(...)` has to serve two callers now: the ledger insert,
 * which is awaited directly, and the wallet upsert, which chains
 * `.onConflictDoUpdate(...).returning(...)`. The returned value is therefore a
 * thenable that also carries the upsert link.
 */
function makeUpsertAwareInsert(captured: WalletCapture, settledBalance: number) {
  return jest.fn().mockImplementation(() => ({
    values: jest.fn().mockImplementation(
      (args: { amount?: number; balanceAfter?: number; balance?: number }) => {
        if (args.balanceAfter !== undefined) captured.txBalanceAfter = args.balanceAfter;
        if (args.amount !== undefined) captured.txAmount = args.amount;
        if (args.balanceAfter === undefined && args.balance !== undefined)
          captured.insertedBalance = args.balance;
        return Object.assign(Promise.resolve([]), {
          onConflictDoUpdate: jest.fn().mockImplementation(
            (config: { set: { balance?: unknown } }) => {
              captured.conflictSetBalance = config.set.balance;
              return {
                returning: jest.fn().mockImplementation(() => {
                  captured.walletBalance = settledBalance;
                  return Promise.resolve([{ balance: settledBalance }]);
                }),
              };
            },
          ),
        });
      },
    ),
  }));
}

function buildGrantFromWebhookDb(prevBalance: number) {
  const captured: WalletCapture = {
    walletBalance: null,
    txAmount: null,
    txBalanceAfter: null,
  };

  let selectCallCount = 0;

  const db = {
    select: jest.fn().mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return makeSelectChain([PACK]);
      }
      return makeSelectChain([{ balance: prevBalance }]);
    }),
    insert: makeUpsertAwareInsert(captured, prevBalance + PACK_MILLI),
    transaction: jest.fn().mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    ),
  };

  return { db, captured };
}

describe("AI credits — balanceAfter invariant: balanceAfter = prev_balance + amount", () => {
  it("grantAiPackCreditsFromWebhook: balanceAfter in transaction = previous balance + credits granted", async () => {
    const prevBalance = 300_000;
    const { db, captured } = buildGrantFromWebhookDb(prevBalance);

    const svc = await buildSvc(db);
    await svc.grantAiPackCreditsFromWebhook("org1", PACK.id, "pay_inv_001");

    expect(captured.txAmount).toBe(PACK_MILLI);
    expect(captured.txBalanceAfter).toBe(prevBalance + PACK_MILLI);
    expect(captured.walletBalance).toBe(prevBalance + PACK_MILLI);
  });

  it("wallet balance and transaction balanceAfter are identical — ledger never drifts", async () => {
    const prevBalance = 0;
    const { db, captured } = buildGrantFromWebhookDb(prevBalance);

    const svc = await buildSvc(db);
    await svc.grantAiPackCreditsFromWebhook("org1", PACK.id, "pay_inv_002");

    expect(captured.walletBalance).toBe(captured.txBalanceAfter);
  });

  it("ledger stores integer milli-credits — 1 credit = 1,000 milli, never fractional", () => {
    expect(Number.isInteger(PACK_MILLI)).toBe(true);
    expect(creditsToMilli(1)).toBe(1_000);
    expect(milliToCredits(1_000)).toBe(1);
  });

  it("purchaseCreditsDirectly: wallet balance matches balanceAfter written to the transaction table", async () => {
    const startBalance = 50_000;
    const captured: WalletCapture = { walletBalance: null, txBalanceAfter: null };

    let selectCallCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return makeSelectChain([PACK]);
        return makeSelectChain([{ balance: startBalance }]);
      }),
      insert: makeUpsertAwareInsert(captured, startBalance + PACK_MILLI),
      transaction: jest.fn().mockImplementation(
        (fn: (tx: unknown) => Promise<unknown>) => fn(db),
      ),
    };

    const svc = await buildSvc(db);
    await svc.purchaseCreditsDirectly("org1", "user1", PACK.id);

    expect(captured.walletBalance).toBe(startBalance + PACK_MILLI);
    expect(captured.txBalanceAfter).toBe(startBalance + PACK_MILLI);
    expect(captured.walletBalance).toBe(captured.txBalanceAfter);
  });

  it("non-zero starting balance: balanceAfter = starting + PACK_MILLI (not just PACK_MILLI)", async () => {
    const startBalance = 750_000;
    const captured: WalletCapture = { walletBalance: null, txBalanceAfter: null };

    let selectCallCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return makeSelectChain([PACK]);
        return makeSelectChain([{ balance: startBalance }]);
      }),
      insert: makeUpsertAwareInsert(captured, startBalance + PACK_MILLI),
      transaction: jest.fn().mockImplementation(
        (fn: (tx: unknown) => Promise<unknown>) => fn(db),
      ),
    };

    const svc = await buildSvc(db);
    await svc.purchaseCreditsDirectly("org1", "user1", PACK.id);

    expect(captured.txBalanceAfter).toBe(startBalance + PACK_MILLI);
    expect(captured.txBalanceAfter).not.toBe(PACK_MILLI);
  });

  it("the wallet credit is an upsert whose balance moves in SQL, never a JS-computed literal", async () => {
    const startBalance = 120_000;
    const captured: WalletCapture = { walletBalance: null, txBalanceAfter: null };

    let selectCallCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return makeSelectChain([PACK]);
        return makeSelectChain([{ balance: startBalance }]);
      }),
      insert: makeUpsertAwareInsert(captured, startBalance + PACK_MILLI),
      transaction: jest.fn().mockImplementation(
        (fn: (tx: unknown) => Promise<unknown>) => fn(db),
      ),
    };

    const svc = await buildSvc(db);
    await svc.purchaseCreditsDirectly("org1", "user1", PACK.id);

    // The insert leg grants the whole pack, so an organisation whose wallet row
    // does not exist yet is credited by the same statement that creates it.
    expect(captured.insertedBalance).toBe(PACK_MILLI);
    // The conflict leg is an increment expression. A number here would mean the
    // balance was read, added to in JavaScript and written back — the shape that
    // let a concurrent grant be erased.
    expect(is(captured.conflictSetBalance, SQL)).toBe(true);
    expect(typeof captured.conflictSetBalance).not.toBe("number");
  });
});

/**
 * The purchase-reference index (`uq_ai_credit_txns_purchase_ref`) is what makes
 * a retried purchase idempotent, so this recovery is the only thing standing
 * between a duplicate webhook and a 500. It has to be provoked with the shape
 * the driver actually throws: a `DrizzleQueryError` carrying no `code` of its
 * own, with the `PostgresError` on `cause`. Rejecting with `{ code: "23505" }`
 * is a shape drizzle never produces, and the assertion passed for years while
 * the recovery it claimed to cover was unreachable.
 */
function duplicatePurchase(): Error {
  return new DrizzleQueryError(
    'insert into "ai_credit_transactions" ...',
    [],
    Object.assign(new Error('duplicate key value violates unique constraint "uq_ai_credit_txns_purchase_ref"'), {
      name: "PostgresError",
      code: "23505",
      table_name: "ai_credit_transactions",
      constraint_name: "uq_ai_credit_txns_purchase_ref",
    }),
  );
}

describe("AI credits — 23505 backstop does not double-credit the wallet", () => {
  it("returns the committed balance when a concurrent purchase loses the reference index", async () => {
    let selectCallCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return makeSelectChain([PACK]);
        return makeSelectChain([{ balance: 100_000 }]);
      }),
      transaction: jest.fn().mockRejectedValue(duplicatePurchase()),
    };

    const svc = await buildSvc(db);
    const result = await svc.purchaseCreditsDirectly("org1", "user1", PACK.id);

    expect(result.balance).toBe(milliToCredits(100_000));
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("grantPlanCredits: a replayed plan grant is a no-op, not a 500", async () => {
    const db = {
      transaction: jest.fn().mockRejectedValue(drizzleUniqueViolation("uq_ai_credit_txns_plan_grant_ref")),
    };

    const svc = await buildSvc(db);
    await expect(svc.grantPlanCredits("org1", "STARTER")).resolves.toBeUndefined();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("grantAiPackCreditsFromWebhook: a redelivered payment is a no-op, and its writes ran in a savepoint", async () => {
    let selectCallCount = 0;
    let insertCallCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return makeSelectChain([PACK]);
        return makeSelectChain([{ balance: 300_000 }]);
      }),
      // First insert is the wallet upsert (`creditWallet`), which succeeds; the
      // second is the PURCHASE ledger row, which hits the reference index.
      insert: jest.fn().mockImplementation(() => {
        insertCallCount++;
        if (insertCallCount === 1)
          return {
            values: () => ({
              onConflictDoUpdate: () => ({
                returning: () => Promise.resolve([{ balance: 300_000 }]),
              }),
            }),
          };
        return {
          values: jest.fn().mockRejectedValue(drizzleUniqueViolation("uq_ai_credit_txns_purchase_ref")),
        };
      }),
      transaction: jest.fn().mockImplementation(
        (fn: (tx: unknown) => Promise<unknown>) => fn(db),
      ),
    };

    const svc = await buildSvc(db);
    await expect(svc.grantAiPackCreditsFromWebhook("org1", PACK.id, "pay_redelivered")).resolves.toBeUndefined();
    // runInTenantTransaction reuses the request transaction, so the swallowed
    // 23505 is only safe if the failed insert sat inside a nested transaction.
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("getWallet: a missing wallet is taken from the reservation service's race-safe ensureWalletForOrg", async () => {
    const winner = {
      id: 1,
      orgId: "org1",
      balance: 250_000,
      lifetimeGranted: 250_000,
      lifetimeConsumed: 0,
      autoTopUpEnabled: false,
      autoTopUpPackId: null,
      autoTopUpThreshold: null,
      updatedAt: new Date(),
    };
    const walletReads: unknown[][] = [[]];
    let selectCallCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        const rows = walletReads[selectCallCount++];
        if (rows) return { from: () => ({ where: () => Promise.resolve(rows) }) };
        return { from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }) };
      }),
    };
    const ensureWalletForOrg = jest.fn().mockResolvedValue(winner);

    const module = await Test.createTestingModule({
      providers: [
        AiCreditsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AiCreditsReservationService, useValue: { ensureWalletForOrg } },
        { provide: AiCreditsPacksService, useValue: {} },
      ],
    }).compile();
    const svc = module.get(AiCreditsService);

    await expect(svc.getWallet("org1")).resolves.toMatchObject({
      wallet: { balance: milliToCredits(250_000) },
    });
    expect(ensureWalletForOrg).toHaveBeenCalledWith("org1");
  });

  it("a different database error propagates untouched", async () => {
    const err = drizzlePostgresError("23503", "some_fk");
    const db = {
      select: jest.fn().mockImplementation(() => makeSelectChain([PACK])),
      transaction: jest.fn().mockRejectedValue(err),
    };

    const svc = await buildSvc(db);
    await expect(svc.purchaseCreditsDirectly("org1", "user1", PACK.id)).rejects.toBe(err);
  });

  it("still rethrows a violation that is not a unique-key conflict", async () => {
    const notNull = new DrizzleQueryError('insert into "ai_credit_transactions" ...', [], Object.assign(
      new Error("null value in column violates not-null constraint"),
      { name: "PostgresError", code: "23502" },
    ));
    const db = {
      select: jest.fn().mockImplementation(() => makeSelectChain([PACK])),
      transaction: jest.fn().mockRejectedValue(notNull),
    };

    const svc = await buildSvc(db);
    await expect(svc.purchaseCreditsDirectly("org1", "user1", PACK.id)).rejects.toBe(notNull);
  });
});

describe("AI credits — milli-credit unit invariants", () => {
  it("milliToCredits is the exact inverse of creditsToMilli for whole-credit values", () => {
    for (const n of [0, 1, 100, 500, 1200]) {
      expect(milliToCredits(creditsToMilli(n))).toBe(n);
    }
  });

  it("balanceAfter stays integer when milli-credits are added (no float drift)", () => {
    const base = 999_999;
    const add = creditsToMilli(1);
    expect(Number.isInteger(base + add)).toBe(true);
  });
});
