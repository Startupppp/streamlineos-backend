jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: async <T>(_db: unknown, fn: (tx: unknown) => Promise<T>, _opts?: unknown) => fn(_db),
}));

import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AiCreditsService } from "./ai-credits.service";
import { AiCreditsReservationService } from "./ai-credits-reservation.service";
import { AiCreditsPacksService } from "./ai-credits-packs.service";
import { creditsToMilli, milliToCredits } from "../../ai/core/billing/ai-model-pricing.constants";

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

function buildGrantFromWebhookDb(prevBalance: number) {
  const captured = {
    walletBalance: null as number | null,
    txAmount: null as number | null,
    txBalanceAfter: null as number | null,
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
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation(
        (args: { amount?: number; balanceAfter?: number; balance?: number }) => {
          if (args.balanceAfter !== undefined) captured.txBalanceAfter = args.balanceAfter;
          if (args.amount !== undefined) captured.txAmount = args.amount;
          return Promise.resolve([]);
        },
      ),
    })),
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockImplementation((args: { balance?: number }) => {
        if (args.balance !== undefined) captured.walletBalance = args.balance;
        return {
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ balance: args.balance ?? prevBalance }]),
          }),
        };
      }),
    })),
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
    const captured = {
      walletBalance: null as number | null,
      txBalanceAfter: null as number | null,
    };

    let selectCallCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return makeSelectChain([PACK]);
        return makeSelectChain([{ balance: startBalance }]);
      }),
      update: jest.fn().mockImplementation(() => ({
        set: jest.fn().mockImplementation((args: { balance?: number }) => {
          captured.walletBalance = args.balance ?? null;
          return {
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ balance: args.balance ?? startBalance }]),
            }),
          };
        }),
      })),
      insert: jest.fn().mockImplementation(() => ({
        values: jest.fn().mockImplementation((args: { balanceAfter?: number }) => {
          if (args.balanceAfter !== undefined) captured.txBalanceAfter = args.balanceAfter;
          return Promise.resolve([]);
        }),
      })),
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
    const captured = { txBalanceAfter: null as number | null };

    let selectCallCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return makeSelectChain([PACK]);
        return makeSelectChain([{ balance: startBalance }]);
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ balance: startBalance + PACK_MILLI }]) }),
        }),
      }),
      insert: jest.fn().mockImplementation(() => ({
        values: jest.fn().mockImplementation((args: { balanceAfter?: number }) => {
          if (args.balanceAfter !== undefined) captured.txBalanceAfter = args.balanceAfter;
          return Promise.resolve([]);
        }),
      })),
      transaction: jest.fn().mockImplementation(
        (fn: (tx: unknown) => Promise<unknown>) => fn(db),
      ),
    };

    const svc = await buildSvc(db);
    await svc.purchaseCreditsDirectly("org1", "user1", PACK.id);

    expect(captured.txBalanceAfter).toBe(startBalance + PACK_MILLI);
    expect(captured.txBalanceAfter).not.toBe(PACK_MILLI);
  });
});

describe("AI credits — 23505 backstop does not double-credit the wallet", () => {
  it("returns without re-granting when a concurrent insert causes 23505", async () => {
    let selectCallCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return makeSelectChain([PACK]);
        return makeSelectChain([{ balance: 100_000 }]);
      }),
      transaction: jest.fn().mockRejectedValue({ code: "23505" }),
    };

    const svc = await buildSvc(db);
    await expect(svc.purchaseCreditsDirectly("org1", "user1", PACK.id)).resolves.not.toThrow();
    expect(db.transaction).toHaveBeenCalledTimes(1);
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
