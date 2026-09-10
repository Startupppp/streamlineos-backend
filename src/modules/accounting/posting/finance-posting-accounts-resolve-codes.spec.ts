import {
  FinancePostingAccountsService,
  PURPOSE_DEFAULT_CODE,
} from "./finance-posting-accounts.service";

/**
 * INV-09 — the read-only half of purpose resolution.
 *
 * Everything else in this service resolves a purpose to an account **id** and
 * writes while it does it: an unmapped purpose is inserted into
 * `acc_system_account_map`, and an unmapped purpose with no default account
 * raises. `resolveAccountCodes` is the version inventory can call, so the three
 * properties that make it callable from a goods receipt are what is asserted:
 * it returns codes, it never writes, and it never throws.
 */
describe("FinancePostingAccountsService.resolveAccountCodes", () => {
  /**
   * One fake for the whole file. `rows` is what the map/account join returns;
   * `insert` and `update` are present so a write can be *observed* rather than
   * merely absent from the assertions — a service that started writing would
   * otherwise pass every test here by throwing a TypeError nobody looks at.
   */
  function fakeDb(rows: Array<{ purpose: string; code: string }>) {
    const where = jest.fn().mockResolvedValue(rows);
    const innerJoin = jest.fn(() => ({ where }));
    const from = jest.fn(() => ({ innerJoin }));
    const select = jest.fn(() => ({ from }));
    const insert = jest.fn(() => {
      throw new Error("resolveAccountCodes must not write");
    });
    const update = jest.fn(() => {
      throw new Error("resolveAccountCodes must not write");
    });
    return { select, from, innerJoin, where, insert, update };
  }

  it("returns the mapped account's code, not the default", async () => {
    const db = fakeDb([{ purpose: "INVENTORY_ASSET", code: "1355" }]);
    const service = new FinancePostingAccountsService(db as never);

    const codes = await service.resolveAccountCodes("org-1", [
      "INVENTORY_ASSET",
      "INVENTORY_GRNI",
    ]);

    // The whole point of INV-09: an admin who maps INVENTORY_ASSET to 1355 gets
    // 1355 posted, and the purposes they left alone keep today's literals.
    expect(codes.INVENTORY_ASSET).toBe("1355");
    expect(codes.INVENTORY_GRNI).toBe(PURPOSE_DEFAULT_CODE.INVENTORY_GRNI);
  });

  it("falls back to the default code for every unmapped purpose", async () => {
    const db = fakeDb([]);
    const service = new FinancePostingAccountsService(db as never);

    const codes = await service.resolveAccountCodes("org-1", [
      "INVENTORY_ASSET",
      "INVENTORY_COGS",
      "INVENTORY_GRNI",
      "AR",
      "SALES_INCOME",
      "AP",
    ]);

    expect(codes).toEqual({
      INVENTORY_ASSET: "1300",
      INVENTORY_COGS: "5000",
      INVENTORY_GRNI: "2000",
      AR: "1200",
      SALES_INCOME: "4000",
      AP: "2000",
    });
  });

  it("writes nothing, unlike every other resolver on this service", async () => {
    const db = fakeDb([]);
    const service = new FinancePostingAccountsService(db as never);

    await service.resolveAccountCodes("org-1", ["INVENTORY_ASSET"]);

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("asks for each purpose once, however many lines name it", async () => {
    const db = fakeDb([]);
    const service = new FinancePostingAccountsService(db as never);

    await service.resolveAccountCodes("org-1", [
      "INVENTORY_ASSET",
      "INVENTORY_ASSET",
      "INVENTORY_ASSET",
    ]);

    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("issues no query at all for an empty purpose list", async () => {
    // `inArray` with an empty array renders `IN ()`, which is a syntax error in
    // Postgres — the guard is load-bearing, not tidiness.
    const db = fakeDb([]);
    const service = new FinancePostingAccountsService(db as never);

    const codes = await service.resolveAccountCodes("org-1", []);

    expect(codes).toEqual({});
    expect(db.select).not.toHaveBeenCalled();
  });

  it("joins the account on org as well as id", async () => {
    // Defence in depth against a map row pointing at another tenant's account:
    // the code that lands in the ledger comes from this join.
    const db = fakeDb([]);
    const service = new FinancePostingAccountsService(db as never);

    await service.resolveAccountCodes("org-1", ["INVENTORY_ASSET"]);

    expect(db.innerJoin).toHaveBeenCalledTimes(1);
  });
});
