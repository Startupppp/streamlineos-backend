import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import { PortalClientService } from "./portal-client.service";

const makeAudit = () => ({ log: jest.fn() }) as unknown as AuditService;

function makeChainableDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  const db = { select } as unknown as Db;
  return { db, where };
}

describe("PortalClientService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const MEMBERSHIP_ID = "mem-001";
  const PROJECT_ID = 5;

  it("returns empty list for a different org's grants (cross-tenant isolation)", async () => {
    const { db } = makeChainableDb([]);
    const svc = new PortalClientService(db, makeAudit());
    const result = await svc.listGrantedProjects(ATTACKER, MEMBERSHIP_ID);
    expect(result).toHaveLength(0);
  });

  it("throws NotFoundException when loading a project from a different org (cross-tenant isolation)", async () => {
    const { db } = makeChainableDb([]);
    const svc = new PortalClientService(db, makeAudit());
    await expect(svc.getProjectOverview(ATTACKER, MEMBERSHIP_ID, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });

  it("returns granted projects for the owning org (control — same-tenant)", async () => {
    const { db } = makeChainableDb([{ projectId: PROJECT_ID }]);
    const svc = new PortalClientService(db, makeAudit());
    const result = await svc.listGrantedProjects(OWNER, MEMBERSHIP_ID);
    expect(result).toHaveLength(1);
  });
});
