import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { BvaService } from "./bva.service";

describe("BvaService — cross-tenant isolation", () => {
  it("throws NotFoundException when the budget belongs to a different org (BOLA isolation)", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    } as unknown as Db;
    const cache = { cachedVersioned: jest.fn() } as never;
    const svc = new BvaService(db, cache, {} as never);

    await expect(svc.getBva("org-attacker", 99, {}, "user-1")).rejects.toThrow(NotFoundException);
  });

  it("does not throw NotFoundException for the owning org (same-tenant control)", async () => {
    const budget = { id: 99, orgId: "org-owner" };
    let call = 0;
    const makeLimit = (rows: unknown[]) => ({ limit: jest.fn().mockResolvedValue(rows) });
    const makeWhere = (rows: unknown[]) => ({ where: jest.fn().mockReturnValue(makeLimit(rows)) });
    const makeGroupBy = () => jest.fn().mockResolvedValue([]);
    const makeChain = (rows: unknown[]) => ({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ ...makeLimit(rows), groupBy: makeGroupBy() }),
      }),
    });
    const db = {
      select: jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) return { from: jest.fn().mockReturnValue(makeWhere([budget])) };
        return makeChain([]);
      }),
    } as unknown as Db;
    const cache = { cachedVersioned: jest.fn().mockImplementation((_n: unknown, _k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new BvaService(db, cache, {} as never);

    const err = await svc.getBva("org-owner", 99, {}, "user-1").catch(e => e);

    expect(err).not.toBeInstanceOf(NotFoundException);
  });
});
