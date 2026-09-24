import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { ProgramsService } from "./programs.service";

describe("ProgramsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const audit = { log: jest.fn() } as never;

  function makeDb(programLoadRows: unknown[], linkedProjectRows: unknown[] = []) {
    const limit1 = jest.fn().mockResolvedValueOnce(programLoadRows).mockResolvedValue(linkedProjectRows);
    const where = jest.fn().mockReturnValue({ limit: limit1 });
    const innerJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ where, innerJoin });
    const select = jest.fn().mockReturnValue({ from });
    return { db: { select } as unknown as Db };
  }

  function makeFullDb(selectRows: unknown[][], insertResult: unknown[] = [{ id: 1, orgId: OWNER_ORG, name: "P" }]) {
    let selectCall = 0;
    const limitFns = selectRows.map((rows) => jest.fn().mockResolvedValue(rows));
    const where = jest.fn().mockImplementation(() => {
      const fn = limitFns[selectCall] ?? jest.fn().mockResolvedValue([]);
      selectCall++;
      return { limit: fn };
    });
    const innerJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ where, innerJoin });
    const select = jest.fn().mockReturnValue({ from });
    const insert = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(insertResult),
      }),
    });
    const update = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(insertResult),
        }),
      }),
    });
    return { select, insert, update } as unknown as Db;
  }

  it("throws NotFoundException for getProgram on a different org (cross-tenant isolation)", async () => {
    const { db } = makeDb([]);
    const svc = new ProgramsService(db, audit);
    await expect(svc.getProgram(ATTACKER_ORG, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns program for the owning org (same-tenant control)", async () => {
    const program = { id: 10, orgId: OWNER_ORG, name: "P1" };
    const { db } = makeDb([program], []);
    const svc = new ProgramsService(db, audit);
    const result = await svc.getProgram(OWNER_ORG, 10);
    expect(result).toMatchObject({ id: 10 });
  });

  describe("createProgram — portfolio ownership validation", () => {
    it("throws NotFoundException when portfolioId does not belong to the caller org (cross-tenant link prevention)", async () => {
      const db = makeFullDb([[]]);
      const svc = new ProgramsService(db, audit);
      await expect(
        svc.createProgram(OWNER_ORG, "user-1", { name: "P1", portfolioId: 999 }),
      ).rejects.toThrow(NotFoundException);
    });

    it("succeeds when portfolioId belongs to the caller org", async () => {
      const portfolioRow = { id: 999, orgId: OWNER_ORG };
      const db = makeFullDb([[portfolioRow]]);
      const svc = new ProgramsService(db, audit);
      const result = await svc.createProgram(OWNER_ORG, "user-1", { name: "P1", portfolioId: 999 });
      expect(result).toMatchObject({ id: 1 });
    });

    it("does not call assertPortfolio when portfolioId is omitted", async () => {
      const db = makeFullDb([]);
      const svc = new ProgramsService(db, audit);
      await expect(
        svc.createProgram(OWNER_ORG, "user-1", { name: "P1" }),
      ).resolves.toMatchObject({ id: 1 });
    });
  });

  describe("updateProgram — portfolio ownership validation", () => {
    it("throws NotFoundException when updating portfolioId to one from a different org", async () => {
      const program = { id: 10, orgId: OWNER_ORG, name: "P1", portfolioId: null };
      const db = makeFullDb([[program], []]);
      const svc = new ProgramsService(db, audit);
      await expect(
        svc.updateProgram(OWNER_ORG, "user-1", 10, { portfolioId: 888 }),
      ).rejects.toThrow(NotFoundException);
    });

    it("succeeds when the new portfolioId belongs to the caller org", async () => {
      const program = { id: 10, orgId: OWNER_ORG, name: "P1", portfolioId: null };
      const portfolio = { id: 888, orgId: OWNER_ORG };
      const db = makeFullDb([[program], [portfolio]]);
      const svc = new ProgramsService(db, audit);
      const result = await svc.updateProgram(OWNER_ORG, "user-1", 10, { portfolioId: 888 });
      expect(result).toMatchObject({ id: 1 });
    });
  });
});
