import type { Db } from "../../../db/drizzle.module";
import { NotFoundException } from "@nestjs/common";
import { ModulesService } from "./modules.service";
import { SprintsService } from "./sprints.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

describe("ModulesService — cross-tenant isolation", () => {
  it("listModules scopes WHERE to requesting org and returns empty for attacker (cross-tenant isolation)", async () => {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) });
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;
    const svc = new ModulesService(db);

    const result = await svc.listModules(ATTACKER_ORG, 1);

    expect(where).toHaveBeenCalled();
    const predicate = where.mock.calls[0]?.[0];
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
    expect(result).toHaveLength(0);
  });

  it("listModules returns modules for the owning org (control — same-tenant access works)", async () => {
    const fakeModule = { id: 1, orgId: OWNER_ORG, name: "Alpha", status: "IN_PROGRESS" };
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([fakeModule]) }) }) }) };
        }
        return { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ groupBy: jest.fn().mockResolvedValue([]) }) }) };
      }),
    } as unknown as Db;
    const svc = new ModulesService(db);

    const result = await svc.listModules(OWNER_ORG, 1);
    expect(result).toHaveLength(1);
  });
});

describe("SprintsService — cross-tenant isolation", () => {
  it("listSprints scopes WHERE to requesting org and returns empty for attacker (cross-tenant isolation)", async () => {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) });
    const db = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;
    const svc = new SprintsService(db, null);

    const result = await svc.listSprints(ATTACKER_ORG, 1);

    expect(where).toHaveBeenCalled();
    const predicate = where.mock.calls[0]?.[0];
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
    expect(result).toHaveLength(0);
  });

  it("listSprints returns sprints for the owning org (control — same-tenant access works)", async () => {
    const fakeSprint = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "Sprint 1", status: "ACTIVE" };
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([fakeSprint]) }) }) }) };
        }
        return { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) };
      }),
    } as unknown as Db;
    const svc = new SprintsService(db, null);

    const result = await svc.listSprints(OWNER_ORG, 1);
    expect(result).toHaveLength(1);
  });

  it("getSprint throws NotFoundException for a sprint not belonging to requesting org (cross-tenant isolation — returns 404 not 403)", async () => {
    const db = {
      query: { sprints: { findFirst: jest.fn().mockResolvedValue(undefined) } },
    } as unknown as Db;
    const svc = new SprintsService(db, null);

    await expect(svc.getSprint(ATTACKER_ORG, 9999)).rejects.toThrow(NotFoundException);
  });
});
