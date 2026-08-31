import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { SalaryStructureTemplatesService } from "./salary-structure-templates.service";

describe("SalaryStructureTemplatesService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeUpdateDb(returnedRows: unknown[]) {
    const returning = jest.fn().mockResolvedValue(returnedRows);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const update = jest.fn().mockReturnValue({ set });
    return { db: { update } as unknown as Db };
  }

  it("throws NotFoundException when updating template for a different org (cross-tenant isolation)", async () => {
    const { db } = makeUpdateDb([]);
    const svc = new SalaryStructureTemplatesService(db);
    await expect(svc.update(ATTACKER_ORG, 99, { name: "Hack" })).rejects.toThrow(NotFoundException);
  });

  it("returns updated template for the owning org (same-tenant control)", async () => {
    const tpl = { id: 1, orgId: OWNER_ORG, name: "Updated" };
    const { db } = makeUpdateDb([tpl]);
    const svc = new SalaryStructureTemplatesService(db);
    const result = await svc.update(OWNER_ORG, 1, { name: "Updated" });
    expect(result).toMatchObject({ id: 1, orgId: OWNER_ORG });
  });
});
