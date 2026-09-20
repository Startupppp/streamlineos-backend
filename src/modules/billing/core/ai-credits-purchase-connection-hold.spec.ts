import { Test } from "@nestjs/testing";
import { NO_TENANT_TRANSACTION } from "../../../common/tenant/no-tenant-transaction.decorator";
import { getTenantContext } from "../../../common/tenant/tenant-context";
import { primeRelocationTrafficTracker } from "../../../common/relocation/relocation-traffic-tracker";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { drizzleUniqueViolation } from "../../../test/postgres-error-fixture";
import { AiCreditsService } from "./ai-credits.service";
import { AiCreditsReservationService } from "./ai-credits-reservation.service";
import { AiCreditsPacksService } from "./ai-credits-packs.service";
import { BillingMarketplaceController } from "./billing-marketplace.controller";

const ORG = "org-ai-credits-hold";

const PACK = {
  id: 3,
  name: "Hold Pack",
  credits: 1000,
  bonusCredits: 200,
  priceInPaise: 99900,
  isActive: true,
  sortOrder: 1,
  createdAt: new Date("2026-09-20T00:00:00.000Z"),
};

const SETTLED_BALANCE = 1_200_000;

interface Statement {
  readonly kind: string;
  readonly depth: number;
  readonly hasTenantContext: boolean;
}

interface Recorded {
  openTransactions: number;
  configuredOrgIds: string[];
  statements: Statement[];
}

function rowsThenable(rows: unknown[]): Record<string, unknown> {
  const link: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy"]) link[method] = () => link;
  link.limit = () => Promise.resolve(rows);
  link.for = () => Promise.resolve(rows);
  link.then = (
    resolve: (value: unknown[]) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(rows).then(resolve, reject);
  return link;
}

function makeDb(options: { ledgerInsertFails: boolean }) {
  const recorded: Recorded = {
    openTransactions: 0,
    configuredOrgIds: [],
    statements: [],
  };

  let depth = 0;
  let selectCalls = 0;
  let insertCalls = 0;

  const record = (kind: string): void => {
    recorded.statements.push({
      kind,
      depth,
      hasTenantContext: getTenantContext() !== undefined,
    });
  };

  const db: Record<string, unknown> = {
    execute: async (query: unknown) => {
      const text = JSON.stringify(query);
      const org = /org-[a-z0-9-]+/.exec(text)?.[0];
      if (/organization_id/.test(text) && org) recorded.configuredOrgIds.push(org);
      return [];
    },
    select: () => {
      selectCalls += 1;
      record(selectCalls === 1 ? "select:pack" : "select:wallet");
      return rowsThenable(selectCalls === 1 ? [PACK] : [{ balance: SETTLED_BALANCE }]);
    },
    insert: () => {
      insertCalls += 1;
      const isWalletUpsert = insertCalls === 1;
      return {
        values: () => {
          record(isWalletUpsert ? "insert:wallet" : "insert:ledger");
          if (!isWalletUpsert && options.ledgerInsertFails)
            return Promise.reject(drizzleUniqueViolation("uq_ai_credit_txns_purchase_ref"));
          return Object.assign(Promise.resolve([]), {
            onConflictDoUpdate: () => ({
              returning: () => Promise.resolve([{ balance: SETTLED_BALANCE }]),
            }),
          });
        },
      };
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      recorded.openTransactions += 1;
      depth += 1;
      try {
        return await fn(db);
      } finally {
        depth -= 1;
      }
    },
  };

  return { db, recorded };
}

async function buildService(db: unknown): Promise<AiCreditsService> {
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

describe("buying AI credits does not hold a pooled connection across the Razorpay round trip", () => {
  beforeEach(() => {
    primeRelocationTrafficTracker([], Date.now());
  });

  it("the purchase route is opted out of the request transaction, because createOrder is a network round trip", () => {
    expect(
      Reflect.getMetadata(
        NO_TENANT_TRANSACTION,
        BillingMarketplaceController.prototype.purchaseAiCredits,
      ),
    ).toBe(true);
  });

  it("ANTI-VACUITY: the wallet read beside it is NOT opted out, so the check reads real metadata", () => {
    expect(
      Reflect.getMetadata(
        NO_TENANT_TRANSACTION,
        BillingMarketplaceController.prototype.getAiCredits,
      ),
    ).toBeUndefined();
  });

  it("the opt-out alone would 42501: the boundary sets app.organization_id before any credit write", async () => {
    const { db, recorded } = makeDb({ ledgerInsertFails: false });
    const service = await buildService(db);

    await service.purchaseCreditsInTenantTransaction(ORG, "user-1", PACK.id, "pay_hold_1");

    expect(recorded.configuredOrgIds).toEqual([ORG]);
  });

  it("issues no statement outside a tenant context, which is what org_ai_credits RLS would reject", async () => {
    const { db, recorded } = makeDb({ ledgerInsertFails: false });
    const service = await buildService(db);

    await service.purchaseCreditsInTenantTransaction(ORG, "user-1", PACK.id, "pay_hold_2");

    expect(recorded.statements.filter((s) => !s.hasTenantContext)).toEqual([]);
    expect(recorded.statements.map((s) => s.kind)).toEqual([
      "select:pack",
      "insert:wallet",
      "insert:ledger",
    ]);
  });

  it("ANTI-VACUITY: the same purchase run without the boundary is recorded as context-less", async () => {
    const { db, recorded } = makeDb({ ledgerInsertFails: false });
    const service = await buildService(db);

    await service.purchaseCreditsDirectly(ORG, "user-1", PACK.id, false, "pay_hold_3");

    expect(recorded.statements.every((s) => !s.hasTenantContext)).toBe(true);
    expect(recorded.configuredOrgIds).toEqual([]);
  });

  it("the credit writes stay in a nested transaction, so a swallowed 23505 cannot abort the boundary", async () => {
    const { db, recorded } = makeDb({ ledgerInsertFails: false });
    const service = await buildService(db);

    await service.purchaseCreditsInTenantTransaction(ORG, "user-1", PACK.id, "pay_hold_4");

    expect(recorded.openTransactions).toBe(2);
    const ledger = recorded.statements.find((s) => s.kind === "insert:ledger");
    expect(ledger?.depth).toBe(2);
  });

  it("a replayed payment reference reads the committed wallet on the still-live boundary transaction", async () => {
    const { db, recorded } = makeDb({ ledgerInsertFails: true });
    const service = await buildService(db);

    const result = await service.purchaseCreditsInTenantTransaction(
      ORG,
      "user-1",
      PACK.id,
      "pay_hold_replay",
    );

    expect(result.creditsAdded).toBe(PACK.credits + PACK.bonusCredits);
    const recovery = recorded.statements.find((s) => s.kind === "select:wallet");
    expect(recovery).toBeDefined();
    expect(recovery?.hasTenantContext).toBe(true);
    expect(recovery?.depth).toBe(1);
  });
});
