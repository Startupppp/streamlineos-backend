import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { OrgHierarchyBranchesService } from "./org-hierarchy-branches.service";
import { OrgHierarchyCostCentersService } from "./org-hierarchy-cost-centers.service";
import { OrgHierarchyLocationsService } from "./org-hierarchy-locations.service";
import { OrgUnitCrudService } from "./org-unit-crud";
import { orgHierarchyCacheStub } from "../../../../test/helpers/org-hierarchy-cache-stub";

const dialect = new PgDialect();

function render(value: Parameters<PgDialect["sqlToQuery"]>[0]) {
  return dialect.sqlToQuery(value);
}

function makeHarness(code: string) {
  const insertValues = jest.fn();
  const returning = jest.fn().mockResolvedValue([
    {
      id: "unit-1",
      orgId: "org-1",
      name: "Unit",
      code,
      description: null,
      status: "ACTIVE",
      parentId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    },
  ]);
  insertValues.mockReturnValue({ returning });
  const findFirst = jest.fn().mockResolvedValue(undefined);
  const db = {
    insert: jest.fn().mockReturnValue({ values: insertValues }),
    query: { orgUnits: { findFirst } },
  } as unknown as Db;
  const crud = new OrgUnitCrudService(
    db,
    { logCritical: jest.fn() },
    orgHierarchyCacheStub(),
  );
  return { crud, findFirst, insertValues };
}

describe("organization unit code strategies", () => {
  it("allows normal kinds to reuse a code from a soft-deleted row", async () => {
    const { crud, findFirst } = makeHarness("NORTH");
    const service = new OrgHierarchyBranchesService(crud);

    await service.createOrgBranch("org-1", "user-1", {
      name: "North",
      code: "NORTH",
    });

    const query = render(findFirst.mock.calls[0]?.[0].where);
    expect(query.sql).toContain('"org_units"."deleted_at" is null');
  });

  it("keeps cost-center codes reserved across soft deletion", async () => {
    const { crud, findFirst } = makeHarness("FIN");
    const service = new OrgHierarchyCostCentersService(crud);

    await service.createCostCenter("org-1", "user-1", {
      name: "Finance",
      code: "FIN",
    });

    const query = render(findFirst.mock.calls[0]?.[0].where);
    expect(query.sql).not.toContain('"org_units"."deleted_at" is null');
  });

  it("derives location codes from names without adding a uniqueness pre-read", async () => {
    const { crud, findFirst, insertValues } = makeHarness("BENGALUR");
    const service = new OrgHierarchyLocationsService(crud);

    await service.createLocation("org-1", "user-1", {
      name: "Bengaluru Main",
      type: "OFFICE",
    });

    expect(findFirst).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ code: "BENGALUR" }),
    );
  });
});
