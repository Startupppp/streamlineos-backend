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
});
