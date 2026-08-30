import type { Db } from "../../../db/drizzle.module";
import { ManagerInboxService } from "./manager-inbox.service";

describe("ManagerInboxService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } as never;
  const reimbursements = { listReimbursements: jest.fn().mockResolvedValue([]) } as never;
  const loans = { listLoans: jest.fn().mockResolvedValue([]) } as never;
  const employmentFacts = { getDirectReportUserIds: jest.fn().mockResolvedValue([]) } as never;

  it("returns empty inbox when attacker has no direct reports in attacker org (cross-tenant isolation)", async () => {
    const db = {} as unknown as Db;
    const svc = new ManagerInboxService(db, access, reimbursements, loans, employmentFacts);
    const result = await svc.getInbox(ATTACKER_ORG, "attacker-u1");
    expect(result.reportCount).toBe(0);
    expect(result.members).toHaveLength(0);
    expect((employmentFacts.getDirectReportUserIds as jest.Mock).mock.calls[0][0]).toBe(ATTACKER_ORG);
  });

  it("returns inbox for the owning org (same-tenant control)", async () => {
    const db = {} as unknown as Db;
    const svc = new ManagerInboxService(db, access, reimbursements, loans, employmentFacts);
    const result = await svc.getInbox(OWNER_ORG, "manager-u1");
    expect(result.mode).toBe("manager_self_service");
  });
});
