import { ConflictException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import {
  ORG_UNIT_DEPENDENCY_ERROR,
  OrgHierarchyDependenciesService,
} from "./org-hierarchy-dependencies.service";

describe("OrgHierarchyDependenciesService", () => {
  const orgId = "org-1";
  const unitId = "00000000-0000-0000-0000-000000000001";
  let execute: jest.Mock;
  let service: OrgHierarchyDependenciesService;

  beforeEach(() => {
    execute = jest.fn();
    service = new OrgHierarchyDependenciesService({ execute } as unknown as Db);
  });

  it("allows an archive when every dependency count is zero", async () => {
    execute.mockResolvedValue([
      { key: "child_units", label: "Active child organization units", count: 0 },
      { key: "worker_assignments", label: "Current worker assignments", count: "0" },
    ]);

    await expect(
      service.assertCanArchive(orgId, unitId, "BUSINESS_UNIT"),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns structured, actionable dependency details instead of archiving", async () => {
    execute.mockResolvedValue([
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
    execute.mockResolvedValue([
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
});
