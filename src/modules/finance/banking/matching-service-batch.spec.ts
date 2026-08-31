import { Test, type TestingModule } from "@nestjs/testing";
import { MatchingService } from "./matching.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import {
  finBankTransactions,
  finReconciliationMatches,
  finReconciliationRules,
  journalEntries,
  payments,
  vendorPayments,
} from "../../../db/schema";
import { humanSessionPrincipal } from "../../../common/auth/principal";

type InsertedMatch = {
  orgId: string;
  bankTransactionId: number;
  matchedType: string;
  confidence: string;
  isConfirmed: boolean;
};

type UpdatedTxnIds = number[];

function makeChain(data: unknown[] = []) {
  const self: Record<string, unknown> = {
    then(resolve: (v: unknown[]) => unknown) { return Promise.resolve(data).then(resolve); },
    catch() { return self; },
  };
  for (const m of ["from", "where", "limit", "orderBy", "innerJoin", "leftJoin", "groupBy", "set", "onConflictDoNothing"]) {
    self[m] = () => self;
  }
  return self;
}

/**
 * Answers each `select()` by the table it reads, never by call order.
 *
 * The previous double indexed a fixed array with `selectCallIdx++`, which
 * assumed `suggestMatches` always issues the same seven queries. It does not:
 * the journal-entry read is conditional on `account.ledgerAccountId`, and every
 * case here leaves that null. Six queries ran against seven datasets, so the
 * client rows were served to the existing-match query, `bankTransactionId` came
 * back `undefined`, and the idempotency guard could never see a prior match.
 * Two tests failed and looked like a duplicate-insert bug in the service; the
 * guard at `matching.service.ts:224-233` was correct the whole time.
 *
 * `clients` is deliberately not among the keyed tables and is served by
 * `fallback` instead. It is one of the four legacy identity tables that
 * `party/legacy-reader-ratchet.spec.ts` watches, and that list may only shrink —
 * importing the symbol here to key a mock would have registered this spec as a
 * new reader of a table the Party migration exists to remove. It is the only
 * table `suggestMatches` reads that is not listed below.
 */
function selectByTable(datasets: Array<[unknown, unknown[]]>, fallback: unknown[]) {
  return () => {
    const chain = makeChain([]);
    chain.from = (table: unknown) => {
      const hit = datasets.find(([t]) => t === table);
      return makeChain(hit ? hit[1] : fallback);
    };
    return chain;
  };
}

type Db = {
  query: {
    finBankAccounts: { findFirst: jest.Mock };
  };
  select: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
};

function makeDb(overrides: Partial<{
  account: object | null;
  rules: unknown[];
  txns: unknown[];
  customerPayments: unknown[];
  vendorPaymentRows: unknown[];
  journalRows: unknown[];
  clientRows: unknown[];
  existingMatches: unknown[];
}>): { db: Db; insertedMatches: InsertedMatch[]; updatedTxnIds: UpdatedTxnIds } {
  const o = {
    account: overrides.account ?? { id: 1, ledgerAccountId: null },
    rules: overrides.rules ?? [],
    txns: overrides.txns ?? [],
    customerPayments: overrides.customerPayments ?? [],
    vendorPaymentRows: overrides.vendorPaymentRows ?? [],
    journalRows: overrides.journalRows ?? [],
    clientRows: overrides.clientRows ?? [],
    existingMatches: overrides.existingMatches ?? [],
  };

  const insertedMatches: InsertedMatch[] = [];
  const updatedTxnIds: UpdatedTxnIds = [];

  const select = selectByTable(
    [
      [finReconciliationRules, o.rules],
      [finBankTransactions, o.txns],
      [payments, o.customerPayments],
      [vendorPayments, o.vendorPaymentRows],
      [journalEntries, o.journalRows],
      [finReconciliationMatches, o.existingMatches],
    ],
    o.clientRows,
  );

  const db: Db = {
    query: {
      finBankAccounts: {
        findFirst: jest.fn().mockResolvedValue(o.account),
      },
    },
    select: jest.fn().mockImplementation(select),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((rows: InsertedMatch | InsertedMatch[]) => {
        const arr = Array.isArray(rows) ? rows : [rows];
        insertedMatches.push(...arr);
        return {
          onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
          then: (r: (v: unknown) => unknown) => Promise.resolve([]).then(r),
        };
      }),
    })),
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((_cond: unknown, ids?: number[]) => {
          if (ids) updatedTxnIds.push(...ids);
          return {
            then: (r: (v: unknown) => unknown) => Promise.resolve([]).then(r),
            catch: () => {},
          };
        }),
      }),
    })),
  };

  return { db, insertedMatches, updatedTxnIds };
}

const ORG_ID = "org1";
const BANK_ACCOUNT_ID = 10;
const U = { orgId: ORG_ID, userId: "u1", role: "member", isOrgOwner: false, tokenScopes: null, sessionId: "", principal: humanSessionPrincipal(1, false) } as const;

const TXN_UNMATCHED = {
  id: 1,
  orgId: ORG_ID,
  bankAccountId: BANK_ACCOUNT_ID,
  txnDate: "2024-01-15",
  amount: "1000.00",
  description: "Payment from ACME",
  counterparty: "ACME Corp",
  reference: "INV-001",
  status: "UNMATCHED",
};

const TXN_UNMATCHED_2 = {
  id: 2,
  orgId: ORG_ID,
  bankAccountId: BANK_ACCOUNT_ID,
  txnDate: "2024-01-16",
  amount: "500.00",
  description: "Fee",
  counterparty: null,
  reference: null,
  status: "UNMATCHED",
};

describe("MatchingService.suggestMatches() — batch reads and writes", () => {
  let service: MatchingService;

  afterEach(() => jest.clearAllMocks());

  it("matching customer payment (score ≥ 60) → match inserted, txn status updated", async () => {
    const { db, insertedMatches } = makeDb({
      txns: [TXN_UNMATCHED],
      customerPayments: [
        { id: 50, amount: "1000.00", paymentDate: "2024-01-15", referenceNumber: "INV-001", clientId: 99 },
      ],
      clientRows: [{ id: 99, name: "ACME Corp" }],
      existingMatches: [],
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [MatchingService, { provide: DRIZZLE, useValue: db }],
    }).compile();
    service = module.get(MatchingService);

    await service.suggestMatches(U, BANK_ACCOUNT_ID);

    expect(insertedMatches).toHaveLength(1);
    expect(insertedMatches[0]).toMatchObject({
      bankTransactionId: 1,
      matchedType: "CUSTOMER_PAYMENT",
      isConfirmed: false,
    });
    expect(db.update).toHaveBeenCalled();
  });

  it("txn with pre-existing match → no new insert (idempotent)", async () => {
    const { db, insertedMatches } = makeDb({
      txns: [TXN_UNMATCHED],
      customerPayments: [
        { id: 50, amount: "1000.00", paymentDate: "2024-01-15", referenceNumber: "INV-001", clientId: 99 },
      ],
      clientRows: [{ id: 99, name: "ACME Corp" }],
      existingMatches: [{ bankTransactionId: 1 }],
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [MatchingService, { provide: DRIZZLE, useValue: db }],
    }).compile();
    service = module.get(MatchingService);

    await service.suggestMatches(U, BANK_ACCOUNT_ID);

    expect(insertedMatches).toHaveLength(0);
  });

  it("score below 60 (amount mismatch) → no match inserted", async () => {
    const { db, insertedMatches } = makeDb({
      txns: [TXN_UNMATCHED],
      customerPayments: [
        { id: 50, amount: "999.00", paymentDate: "2024-01-15", referenceNumber: null, clientId: null },
      ],
      existingMatches: [],
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [MatchingService, { provide: DRIZZLE, useValue: db }],
    }).compile();
    service = module.get(MatchingService);

    await service.suggestMatches(U, BANK_ACCOUNT_ID);

    expect(insertedMatches).toHaveLength(0);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("two txns, one matching rule and one matching candidate → both inserted in a single batch", async () => {
    const rule = {
      id: 1,
      orgId: ORG_ID,
      isActive: true,
      priority: 10,
      conditions: [{ field: "description", op: "contains", value: "fee" }],
      action: { type: "fee" },
    };

    const { db, insertedMatches } = makeDb({
      rules: [rule],
      txns: [TXN_UNMATCHED_2, TXN_UNMATCHED],
      customerPayments: [
        { id: 50, amount: "1000.00", paymentDate: "2024-01-15", referenceNumber: "INV-001", clientId: 99 },
      ],
      clientRows: [{ id: 99, name: "ACME Corp" }],
      existingMatches: [],
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [MatchingService, { provide: DRIZZLE, useValue: db }],
    }).compile();
    service = module.get(MatchingService);

    await service.suggestMatches(U, BANK_ACCOUNT_ID);

    expect(insertedMatches).toHaveLength(2);
    const types = insertedMatches.map((m) => m.matchedType);
    expect(types).toContain("BANK_FEE");
    expect(types).toContain("CUSTOMER_PAYMENT");
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("no transactions → exits without any inserts or updates", async () => {
    const { db } = makeDb({ txns: [] });

    const module: TestingModule = await Test.createTestingModule({
      providers: [MatchingService, { provide: DRIZZLE, useValue: db }],
    }).compile();
    service = module.get(MatchingService);

    await service.suggestMatches(U, BANK_ACCOUNT_ID);

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("rule match sets confidence '90.00'", async () => {
    const rule = {
      id: 1,
      orgId: ORG_ID,
      isActive: true,
      priority: 10,
      conditions: [{ field: "description", op: "contains", value: "payment from acme" }],
      action: { type: "categorize" },
    };

    const { db, insertedMatches } = makeDb({
      rules: [rule],
      txns: [TXN_UNMATCHED],
      existingMatches: [],
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [MatchingService, { provide: DRIZZLE, useValue: db }],
    }).compile();
    service = module.get(MatchingService);

    await service.suggestMatches(U, BANK_ACCOUNT_ID);

    expect(insertedMatches).toHaveLength(1);
    expect(insertedMatches[0]?.confidence).toBe("90.00");
  });

  it("running twice with same txns → second run inserts nothing (pre-fetched set covers prior inserts)", async () => {
    const { db: db1, insertedMatches: matches1 } = makeDb({
      txns: [TXN_UNMATCHED],
      customerPayments: [{ id: 50, amount: "1000.00", paymentDate: "2024-01-15", referenceNumber: "INV-001", clientId: null }],
      existingMatches: [],
    });
    const mod1 = await Test.createTestingModule({
      providers: [MatchingService, { provide: DRIZZLE, useValue: db1 }],
    }).compile();
    await mod1.get(MatchingService).suggestMatches(U, BANK_ACCOUNT_ID);
    expect(matches1).toHaveLength(1);

    const { db: db2, insertedMatches: matches2 } = makeDb({
      txns: [TXN_UNMATCHED],
      customerPayments: [{ id: 50, amount: "1000.00", paymentDate: "2024-01-15", referenceNumber: "INV-001", clientId: null }],
      existingMatches: [{ bankTransactionId: 1 }],
    });
    const mod2 = await Test.createTestingModule({
      providers: [MatchingService, { provide: DRIZZLE, useValue: db2 }],
    }).compile();
    await mod2.get(MatchingService).suggestMatches(U, BANK_ACCOUNT_ID);
    expect(matches2).toHaveLength(0);
  });
});
