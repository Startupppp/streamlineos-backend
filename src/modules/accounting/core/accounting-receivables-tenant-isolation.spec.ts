import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { AccountingReceivablesService } from "./accounting-receivables.service";
import type { AccountingAgedReceivablesService } from "./accounting-aged-receivables.service";

const agedService = {} as AccountingAgedReceivablesService;

function makeEmptyDb(): Db {
  const make = () => {
    const p = Object.assign(Promise.resolve([] as unknown[]), {
      limit: jest.fn().mockResolvedValue([]),
      orderBy: jest.fn().mockReturnValue(Promise.resolve([])),
    });
    const src: { where: jest.Mock; innerJoin: jest.Mock } = {
      where: jest.fn().mockReturnValue(p),
      innerJoin: jest.fn(),
    };
    src.innerJoin.mockReturnValue(src);
    return { from: jest.fn().mockReturnValue(src) };
  };
  return { select: jest.fn().mockImplementation(make) } as unknown as Db;
}

describe("AccountingReceivablesService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  it("throws NotFoundException when client belongs to a different org (cross-tenant isolation)", async () => {
    const svc = new AccountingReceivablesService(makeEmptyDb(), agedService);
    await expect(svc.customerLedger(ATTACKER_ORG, 42, {})).rejects.toThrow(NotFoundException);
  });

  it("resolves the customer ledger for the owning org (same-tenant control)", async () => {
    const clientRow = { id: 1, name: "Client A", state: null, gstin: null };
    let idx = 0;
    const make = () => {
      const i = idx++;
      const rows: unknown[] =
        i === 0 ? [clientRow] :
        i === 3 || i === 4 ? [{ total: "0" }] :
        [];
      const p = Object.assign(Promise.resolve(rows), {
        limit: jest.fn().mockResolvedValue(rows),
        orderBy: jest.fn().mockReturnValue(Promise.resolve(rows)),
      });
      const src: { where: jest.Mock; innerJoin: jest.Mock } = {
        where: jest.fn().mockReturnValue(p),
        innerJoin: jest.fn(),
      };
      src.innerJoin.mockReturnValue(src);
      return { from: jest.fn().mockReturnValue(src) };
    };
    const db = { select: jest.fn().mockImplementation(make) } as unknown as Db;
    const svc = new AccountingReceivablesService(db, agedService);
    const result = await svc.customerLedger(OWNER_ORG, 1, {});
    expect(result.summary.clientName).toBe("Client A");
  });
});
