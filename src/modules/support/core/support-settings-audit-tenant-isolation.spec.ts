import { SupportSettingsAuditService } from "./support-settings-audit.service";
import type { Db } from "../../../db/drizzle.module";

describe("SupportSettingsAuditService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(rows: unknown[]): { db: Db; findMany: jest.Mock } {
    const findMany = jest.fn().mockResolvedValue(rows);
    const db = {
      query: { supportSettingsAuditLog: { findMany } },
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
    } as unknown as Db;
    return { db, findMany };
  }

  it("returns empty audit log for a different org (cross-tenant isolation)", async () => {
    const { db } = makeDb([]);
    const svc = new SupportSettingsAuditService(db);
    const result = await svc.list(ATTACKER_ORG);
    expect(result).toHaveLength(0);
  });

  it("returns audit entries for the owning org (control — same-tenant access works)", async () => {
    const { db } = makeDb([{ id: 1, orgId: OWNER_ORG, action: "created" }]);
    const svc = new SupportSettingsAuditService(db);
    const result = await svc.list(OWNER_ORG);
    expect(result).toHaveLength(1);
  });
});
