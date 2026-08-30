import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { TestManagementService } from "./test-management.service";

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

describe("TestManagementService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(projectRow: unknown | null, suiteRows: unknown[]) {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(suiteRows) }) });
    const from = jest.fn().mockReturnValue({ where });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(projectRow) },
        testSuites: { findFirst: jest.fn().mockResolvedValue(null) },
        testCases: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
  }

  it("throws NotFoundException for listSuites when project not in org (cross-tenant isolation)", async () => {
    const db = makeDb(null, []);
    const svc = new TestManagementService(db);
    await expect(svc.listSuites(ATTACKER_ORG, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns suites for the owning org (same-tenant control)", async () => {
    const project = { id: 1, orgId: OWNER_ORG };
    const suite = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "Suite A" };
    const db = makeDb(project, [suite]);
    const svc = new TestManagementService(db);
    const result = await svc.listSuites(OWNER_ORG, 1);
    expect(result).toHaveLength(1);
  });
});
