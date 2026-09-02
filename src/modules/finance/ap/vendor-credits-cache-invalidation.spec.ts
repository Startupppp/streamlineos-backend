import { ConflictException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { VendorCreditsService } from "./vendor-credits.service";

const ORG_ID = "org-vc-test";
const USER_ID = "user-vc";
const VC_ID = 7;
const BILL_ID = 3;

const MOCK_VC = {
  id: VC_ID,
  orgId: ORG_ID,
  vendorCreditNumber: "VC-0001",
  vendorId: 1,
  creditDate: "2024-01-15",
  status: "DRAFT",
  subtotal: "500.00",
  taxAmount: "0.00",
  total: "500.00",
  appliedAmount: "0.00",
  notes: null,
  createdBy: USER_ID,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_BILL = {
  id: BILL_ID,
  orgId: ORG_ID,
  billNumber: "BILL-0001",
  status: "POSTED",
  total: "500.00",
  amountPaid: "0.00",
};

const MOCK_VC_POSTED = { ...MOCK_VC, status: "POSTED" };
const MOCK_SEQ = { next: 2, padding: 4 };

function buildDb(affectedRows: Array<{ id: number }> = [{ id: VC_ID }]) {
  const txFn = jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([MOCK_VC]),
        }),
      }),
      /*
       * `applyVendorCredit` moves the credit and the bill with conditional
       * updates and reads the affected rows back — zero rows means someone else
       * applied first. The mock therefore has to answer `.returning()`.
       */
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue(
            Object.assign(Promise.resolve(undefined), {
              returning: jest.fn().mockResolvedValue(affectedRows),
            }),
          ),
        }),
      }),
    };
    return cb(tx);
  });

  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([MOCK_VC]) }),
        leftJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([MOCK_VC]) }),
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([MOCK_VC]),
        onConflictDoUpdate: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([MOCK_SEQ]),
        }),
        onConflictDoNothing: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    transaction: txFn,
  } as unknown as Db;
}

function buildService(db: Db, cache: { invalidate: jest.Mock }) {
  const audit = { log: jest.fn() };
  const journalPosting = { seedChartOfAccountsForOrg: jest.fn().mockResolvedValue(undefined) };
  const financePosting = {
    postJournal: jest.fn().mockResolvedValue({ entryId: 99 }),
    resolveSystemAccount: jest.fn().mockResolvedValue(10),
  };
  const u = { userId: USER_ID, orgId: ORG_ID, role: "ADMIN", isOrgOwner: false, sessionId: "s1", tokenScopes: null, principal: null };
  return { svc: new VendorCreditsService(db, audit as never, cache as never, financePosting as never, journalPosting as never), u };
}

function orderedCache(order: string[]) {
  const invalidate = jest.fn().mockImplementation(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    order.push("invalidate");
  });
  return { invalidate };
}

describe("VendorCreditsService — cache.invalidate is not fire-and-forget", () => {
  it("createVendorCredit resolves only after invalidation completes for the org-scoped vc-cache key", async () => {
    const order: string[] = [];
    const cache = orderedCache(order);
    const db = buildDb();
    const { svc } = buildService(db, cache);

    await svc.createVendorCredit(ORG_ID, USER_ID, {
      vendorId: 1,
      currency: "INR",
      items: [],
    });

    order.push("method");
    expect(order).toEqual(["invalidate", "method"]);
    expect(String(cache.invalidate.mock.calls[0]?.[0])).toContain(ORG_ID);
  });

  it("postVendorCredit resolves only after invalidation completes for the org-scoped vc-cache key", async () => {
    const order: string[] = [];
    const cache = orderedCache(order);
    const db = buildDb();
    const { svc, u } = buildService(db, cache);

    await svc.postVendorCredit(u as never, VC_ID);

    order.push("method");
    expect(order).toEqual(["invalidate", "method"]);
    expect(String(cache.invalidate.mock.calls[0]?.[0])).toContain(ORG_ID);
  });

  it("applyVendorCredit resolves only after invalidation completes for the org-scoped vc-cache key", async () => {
    const order: string[] = [];
    const cache = orderedCache(order);
    const db = buildDb();

    const selectFn = jest.fn()
      .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([MOCK_VC_POSTED]) }) }) })
      .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([MOCK_BILL]) }) }) });

    const enrichedDb = { ...db, select: selectFn };
    const { svc, u } = buildService(enrichedDb as unknown as Db, cache);

    await svc.applyVendorCredit(u as never, VC_ID, { billId: BILL_ID, amount: 100 });

    order.push("method");
    expect(order).toEqual(["invalidate", "method"]);
    expect(String(cache.invalidate.mock.calls[0]?.[0])).toContain(ORG_ID);
  });

  it("applyVendorCredit conflicts when the conditional update moves no row", async () => {
    const cache = orderedCache([]);
    // Zero affected rows is how the database says a concurrent apply already
    // consumed the credit. Spending it twice used to be silent.
    const db = buildDb([]);

    const selectFn = jest.fn()
      .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([MOCK_VC_POSTED]) }) }) })
      .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([MOCK_BILL]) }) }) });

    const enrichedDb = { ...db, select: selectFn };
    const { svc, u } = buildService(enrichedDb as unknown as Db, cache);

    await expect(
      svc.applyVendorCredit(u as never, VC_ID, { billId: BILL_ID, amount: 100 }),
    ).rejects.toThrow(ConflictException);
    expect(cache.invalidate).not.toHaveBeenCalled();
  });
});
