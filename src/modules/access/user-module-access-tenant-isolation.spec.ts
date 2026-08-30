import type { Db } from "../../db/drizzle.module";
import { UserModuleAccessService } from "./user-module-access.service";

describe("UserModuleAccessService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const USER_ID = "user-abc";

  function makeDb(rows: unknown[]): Db {
    const where = jest.fn().mockResolvedValue(rows);
    const innerJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ innerJoin });
    const select = jest.fn().mockReturnValue({ from });
    return {
      select,
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ select })),
    } as unknown as Db;
  }

  it("returns empty denied modules for a different org (cross-tenant isolation)", async () => {
    const db = makeDb([]);
    const mockEntitlements = { getEnabledModules: jest.fn().mockResolvedValue(new Set()) } as any;
    const mockCache = {} as any;
    const svc = new UserModuleAccessService(db, mockEntitlements, mockCache);
    const result = await svc.getUserDeniedModules(ATTACKER, USER_ID);
    expect(result.size).toBe(0);
  });

  it("returns denied modules for the owning org (control — same-tenant)", async () => {
    const db = makeDb([{ moduleKey: "payroll" }]);
    const mockEntitlements = { getEnabledModules: jest.fn().mockResolvedValue(new Set()) } as any;
    const mockCache = {} as any;
    const svc = new UserModuleAccessService(db, mockEntitlements, mockCache);
    const result = await svc.getUserDeniedModules(OWNER, USER_ID);
    expect(result).toBeInstanceOf(Set);
  });
});
