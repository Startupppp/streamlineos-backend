import type { Db } from "../../../db/drizzle.module";
import { NotFoundException } from "@nestjs/common";
import { EpicsService } from "./epics.service";
import { CyclesService } from "./cycles.service";

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

describe("EpicsService — cross-tenant isolation", () => {
  it("listEpics refuses a project the requesting org does not own (404, not an empty 200)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const projectFindFirst = jest.fn().mockResolvedValue(undefined);
    const db = { query: { projects: { findFirst: projectFindFirst }, tickets: { findMany } } } as unknown as Db;
    const svc = new EpicsService(db);

    await expect(svc.listEpics(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);

    expect(findMany).not.toHaveBeenCalled();
    const predicate = projectFindFirst.mock.calls[0]?.[0]?.where;
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
  });

  it("listEpics returns epics for the owning org (control — same-tenant access works)", async () => {
    const fakeEpic = { id: 1, orgId: OWNER_ORG, title: "Epic 1", type: "EPIC" };
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
        tickets: { findMany: jest.fn().mockResolvedValue([fakeEpic]) },
      },
    } as unknown as Db;
    const svc = new EpicsService(db);

    const result = await svc.listEpics(OWNER_ORG, 1);
    expect(result).toHaveLength(1);
  });
});

describe("CyclesService — cross-tenant isolation", () => {
  it("listCycles refuses a project the requesting org does not own (404, not an empty 200)", async () => {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) });
    const projectFindFirst = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: { projects: { findFirst: projectFindFirst } },
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    } as unknown as Db;
    const svc = new CyclesService(db);

    await expect(svc.listCycles(ATTACKER_ORG, 1, {})).rejects.toThrow(NotFoundException);

    expect(where).not.toHaveBeenCalled();
    const predicate = projectFindFirst.mock.calls[0]?.[0]?.where;
    expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
    expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
  });

  it("listCycles returns cycles for the owning org (control — same-tenant access works)", async () => {
    const fakeCycle = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "Sprint 1", status: "ACTIVE" };
    let call = 0;
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
      select: jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([fakeCycle]) }) }) }) };
        }
        return { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ groupBy: jest.fn().mockResolvedValue([]) }) }) };
      }),
    } as unknown as Db;
    const svc = new CyclesService(db);

    const result = await svc.listCycles(OWNER_ORG, 1, {});
    expect(result).toHaveLength(1);
  });
});
