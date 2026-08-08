import { ConflictException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import {
  ORG_UNIT_DEPENDENCY_ERROR,
  OrgHierarchyDependenciesService,
} from "./org-hierarchy-dependencies.service";

function sqlText(value: unknown, seen = new Set<object>()): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sqlText(item, seen)).join(" ");
  }
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [sqlText(record.queryChunks, seen), sqlText(record.value, seen)].join(
    " ",
  );
}

describe("OrgHierarchyDependenciesService", () => {
  const orgId = "org-1";
  const unitId = "00000000-0000-0000-0000-000000000001";
  let execute: jest.Mock;
  let service: OrgHierarchyDependenciesService;

  beforeEach(() => {
    execute = jest.fn();
    service = new OrgHierarchyDependenciesService({ execute } as unknown as Db);
  });

  function mockDependencyRows(rows: unknown[], legalEntitiesAvailable = false) {
    execute
      .mockResolvedValueOnce([{ available: legalEntitiesAvailable }])
      .mockResolvedValueOnce(rows);
  }

  it("allows an archive when every dependency count is zero", async () => {
    mockDependencyRows([
      { key: "child_units", label: "Active child organization units", count: 0 },
      { key: "worker_assignments", label: "Current worker assignments", count: "0" },
    ]);

    await expect(
      service.assertCanArchive(orgId, unitId, "BUSINESS_UNIT"),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("returns structured, actionable dependency details instead of archiving", async () => {
    mockDependencyRows([
      { key: "child_units", label: "Active child organization units", count: "2" },
      { key: "worker_assignments", label: "Current worker assignments", count: 3 },
      { key: "access_groups", label: "Access groups scoped to this unit", count: 0 },
    ]);

    let thrown: unknown;
    try {
      await service.assertCanArchive(orgId, unitId, "BUSINESS_UNIT");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getResponse()).toEqual({
      code: ORG_UNIT_DEPENDENCY_ERROR,
      message:
        "This business unit is still in use. Move or update its dependent records before you archive it.",
      details: {
        unitId,
        unitKind: "BUSINESS_UNIT",
        action: "archive",
        dependencies: [
          { key: "child_units", label: "Active child organization units", count: 2 },
          { key: "worker_assignments", label: "Current worker assignments", count: 3 },
        ],
        totalDependencies: 5,
      },
    });
  });

  it("uses the stricter remove action for legacy DELETE endpoints", async () => {
    mockDependencyRows([
      { key: "documents", label: "Documents filed under this department", count: 1 },
    ]);

    let thrown: unknown;
    try {
      await service.assertCanRetire(orgId, unitId, "DEPARTMENT");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getStatus()).toBe(409);
    const response = (thrown as ConflictException).getResponse() as {
      details: { action: string };
    };
    expect(response.details.action).toBe("remove");
  });

  it.each(["DEPARTMENT", "LOCATION"] as const)(
    "excludes completed employment lifecycle values from %s archive checks",
    async (kind) => {
      mockDependencyRows([]);

      await service.assertCanArchive(orgId, unitId, kind);

      const query = sqlText(execute.mock.calls[1]?.[0]);
      expect(query).toContain("EXITED");
      expect(query).toContain("ALUMNI");
    },
  );

  it("does not treat completed department records as active archive blockers", async () => {
    mockDependencyRows([]);

    await service.assertCanArchive(orgId, unitId, "DEPARTMENT");
    const archiveQuery = sqlText(execute.mock.calls[1]?.[0]);

    expect(archiveQuery).toEqual(expect.stringContaining("CLOSED"));
    expect(archiveQuery).toEqual(expect.stringContaining("FILLED"));
    expect(archiveQuery).toEqual(expect.stringContaining("REJECTED"));
    expect(archiveQuery).toEqual(expect.stringContaining("JOB_CREATED"));
    expect(archiveQuery).toEqual(expect.stringContaining("closed"));

    execute.mockClear();
    mockDependencyRows([]);
    await service.assertCanRetire(orgId, unitId, "DEPARTMENT");
    const retireQuery = sqlText(execute.mock.calls[1]?.[0]);

    expect(retireQuery).not.toEqual(expect.stringContaining("JOB_CREATED"));
    expect(retireQuery).not.toEqual(expect.stringContaining("'closed'"));
  });

  it("omits staged legal-entity checks when that relation is unavailable", async () => {
    mockDependencyRows([]);

    await service.assertCanArchive(orgId, unitId, "TEAM");

    const query = sqlText(execute.mock.calls[1]?.[0]);
    expect(query).not.toContain("legal_entities");
  });

  it("includes legal-entity dependencies after that relation is available", async () => {
    mockDependencyRows([], true);

    await service.assertCanArchive(orgId, unitId, "TEAM");

    const query = sqlText(execute.mock.calls[1]?.[0]);
    expect(query).toContain("legal_entities");
  });
});
