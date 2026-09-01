import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { PrincipalGroupsService } from "./principal-groups.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("PrincipalGroupsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const GROUP_ID = "grp-abc";

  function makeDb(groupRow: unknown, listRows: unknown[] = []): { db: Db; where: jest.Mock } {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ offset: jest.fn().mockResolvedValue(listRows) }) }) });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    const findFirst = jest.fn().mockResolvedValue(groupRow);
    const db = {
      select,
      query: { principalGroups: { findFirst } },
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
        query: { principalGroups: { findFirst } },
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
        execute: jest.fn().mockResolvedValue([]),
      })),
    } as unknown as Db;
    return { db, where };
  }

  it("returns empty groups for a different org (cross-tenant isolation)", async () => {
    const { db, where } = makeDb(null, []);
    const mockAccess = {} as any;
    const svc = new PrincipalGroupsService(db, mockAccess);
    const result = await svc.list(ATTACKER, { limit: 20 });
    expect(result.data).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("throws NotFoundException when group belongs to a different org (cross-tenant isolation)", async () => {
    const { db } = makeDb(null);
    const mockAccess = {} as any;
    const svc = new PrincipalGroupsService(db, mockAccess);
    await expect(svc.getMembers(ATTACKER, GROUP_ID)).rejects.toThrow(NotFoundException);
  });

  it("returns groups for the owning org (control — same-tenant)", async () => {
    const groupRow = { id: GROUP_ID, orgId: OWNER, name: "Devs", kind: "custom" };
    const { db } = makeDb(groupRow, [groupRow]);
    const mockAccess = {} as any;
    const svc = new PrincipalGroupsService(db, mockAccess);
    const result = await svc.list(OWNER, { limit: 20 });
    expect(result.data).toHaveLength(1);
  });
});
