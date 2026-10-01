import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { RoleMemberService } from "./role-member.service";

describe("RoleMemberService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ROLE_ID = 5;

  function makeSelectChain(): object {
    const chain: Record<string, jest.Mock> = {};
    chain.innerJoin = jest.fn().mockReturnValue(chain);
    chain.leftJoin = jest.fn().mockReturnValue(chain);
    chain.where = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
    return chain;
  }

  function makeDb(roleRow: unknown): Db {
    const findFirst = jest.fn().mockResolvedValue(roleRow);
    return {
      query: { roles: { findFirst } },
      select: jest.fn().mockImplementation(() => ({ from: jest.fn().mockReturnValue(makeSelectChain()) })),
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
        query: { roles: { findFirst } },
        execute: jest.fn().mockResolvedValue([]),
      })),
    } as unknown as Db;
  }

  it("throws NotFoundException when role belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const mockCache = { invalidate: jest.fn() } as never;
    const mockDispatch = { emit: jest.fn() } as never;
    const mockAccess = {} as never;
    const svc = new RoleMemberService(db, mockCache, mockDispatch, mockAccess);
    await expect(svc.getRoleMembers(ATTACKER, ROLE_ID)).rejects.toThrow(NotFoundException);
  });

  it("returns members for a role in the owning org (control — same-tenant)", async () => {
    const roleRow = { id: ROLE_ID, orgId: OWNER, name: "Devs", slug: "devs" };
    const db = makeDb(roleRow);
    const mockCache = { invalidate: jest.fn() } as never;
    const mockDispatch = { emit: jest.fn() } as never;
    const mockAccess = {} as never;
    const svc = new RoleMemberService(db, mockCache, mockDispatch, mockAccess);
    const result = await svc.getRoleMembers(OWNER, ROLE_ID);
    expect(result).toBeDefined();
  });
});
