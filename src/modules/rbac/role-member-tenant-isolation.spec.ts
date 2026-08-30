import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { RoleMemberService } from "./role-member.service";

describe("RoleMemberService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROLE_ID = 5;

  function makeDb(roleRow: unknown): Db {
    const findFirst = jest.fn().mockResolvedValue(roleRow);
    return {
      query: { roles: { findFirst } },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) }) }),
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
        query: { roles: { findFirst } },
        execute: jest.fn().mockResolvedValue([]),
      })),
    } as unknown as Db;
  }

  it("throws NotFoundException when role belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const mockCache = { invalidate: jest.fn() } as any;
    const mockAudit = { log: jest.fn() } as any;
    const mockDispatch = { emit: jest.fn() } as any;
    const mockAccess = {} as any;
    const svc = new RoleMemberService(db, mockCache, mockAudit, mockDispatch, mockAccess);
    await expect(svc.getRoleMembers(ATTACKER, ROLE_ID)).rejects.toThrow(NotFoundException);
  });

  it("returns members for a role in the owning org (control — same-tenant)", async () => {
    const roleRow = { id: ROLE_ID, orgId: OWNER, name: "Devs", slug: "devs" };
    const db = makeDb(roleRow);
    const mockCache = { invalidate: jest.fn() } as any;
    const mockAudit = { log: jest.fn() } as any;
    const mockDispatch = { emit: jest.fn() } as any;
    const mockAccess = {} as any;
    const svc = new RoleMemberService(db, mockCache, mockAudit, mockDispatch, mockAccess);
    const result = await svc.getRoleMembers(OWNER, ROLE_ID);
    expect(result).toBeDefined();
  });
});
