import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { OrgService } from "./org.service";

describe("OrgService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(rows: unknown[]): Db {
    const limit = jest.fn().mockResolvedValue(rows);
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    return { select } as unknown as Db;
  }

  it("throws NotFoundException for a non-existent org (isolation — no cross-tenant disclosure)", async () => {
    const db = makeDb([]);
    const svc = new OrgService(db);
    await expect(svc.getOrgName(ATTACKER)).rejects.toThrow(NotFoundException);
  });

  it("returns the org name and logo for an existing org (control — correct org)", async () => {
    const db = makeDb([{ name: "Owner Corp", logo: "https://cdn/logo.png" }]);
    const svc = new OrgService(db);
    const result = await svc.getOrgName(OWNER);
    expect(result).toEqual({ name: "Owner Corp", logo: "https://cdn/logo.png" });
  });

  it("returns a null logo rather than omitting the key, because the public help centre header reads it and an absent key is not the same as no logo", async () => {
    const db = makeDb([{ name: "Owner Corp", logo: null }]);
    const svc = new OrgService(db);
    const result = await svc.getOrgName(OWNER);
    expect(result).toEqual({ name: "Owner Corp", logo: null });
  });
});
