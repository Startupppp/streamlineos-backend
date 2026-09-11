import type { Db } from "../../../db/drizzle.module";
import type { ListQueryInput } from "./dto/org-hierarchy.schemas";
import { OrgHierarchyBranchesService } from "./org-hierarchy-branches.service";
import { OrgHierarchyBusinessUnitsService } from "./org-hierarchy-business-units.service";
import { OrgHierarchyCostCentersService } from "./org-hierarchy-cost-centers.service";
import { OrgHierarchyDepartmentsService } from "./org-hierarchy-departments.service";
import { OrgHierarchyLocationsService } from "./org-hierarchy-locations.service";
import { OrgHierarchyTeamsService } from "./org-hierarchy-teams.service";
import { encodeOrgUnitCursor } from "./org-hierarchy-list-filters";
import { OrgUnitCrudService } from "./org-unit-crud";

const ORG_ID = "org-1";
const UNIT_ID = "00000000-0000-0000-0000-000000000001";

type PageResult = {
  data: unknown[];
  pageInfo: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
};

type ListFunction = (
  orgId: string,
  query: ListQueryInput,
) => Promise<PageResult>;

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => sqlValues(item, seen));
  }
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

function makeCursorDb(rows?: Array<Record<string, unknown>>) {
  const row = {
    id: UNIT_ID,
    orgId: ORG_ID,
    parentId: null,
    businessUnitName: null,
    branchName: null,
    departmentName: null,
    headUserId: null,
    name: "North",
    code: "NORTH",
    description: null,
    status: "ACTIVE" as const,
    metadata: { locationType: "OFFICE" as const },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
  };
  const limit = jest.fn().mockResolvedValue(rows ?? [row]);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const rowWhere = jest.fn().mockReturnValue({ orderBy });
  const leftJoin: jest.Mock = jest.fn();
  leftJoin.mockReturnValue({ where: rowWhere, leftJoin });
  const rowFrom = jest.fn().mockReturnValue({ where: rowWhere, leftJoin });
  const select = jest.fn().mockReturnValue({ from: rowFrom });

  return {
    db: { select } as unknown as Db,
    select,
    rowWhere,
    orderBy,
    limit,
  };
}

const audit = { logCritical: jest.fn() };
const cache = { invalidateAfterMutation: jest.fn() };

function createCrud(db: Db) {
  return new OrgUnitCrudService(db, audit, cache);
}

const listCases: Array<{
  label: string;
  kind: string;
  createList: (db: Db) => ListFunction;
}> = [
  {
    label: "business units",
    kind: "BUSINESS_UNIT",
    createList: (db) => {
      const service = new OrgHierarchyBusinessUnitsService(createCrud(db));
      return (orgId, query) => service.listBusinessUnits(orgId, query);
    },
  },
  {
    label: "branches",
    kind: "BRANCH",
    createList: (db) => {
      const service = new OrgHierarchyBranchesService(createCrud(db));
      return (orgId, query) => service.listOrgBranches(orgId, query);
    },
  },
  {
    label: "departments",
    kind: "DEPARTMENT",
    createList: (db) => {
      const service = new OrgHierarchyDepartmentsService(createCrud(db));
      return (orgId, query) => service.listDepartments(orgId, query);
    },
  },
  {
    label: "teams",
    kind: "TEAM",
    createList: (db) => {
      const service = new OrgHierarchyTeamsService(createCrud(db));
      return (orgId, query) => service.listTeams(orgId, query);
    },
  },
  {
    label: "locations",
    kind: "LOCATION",
    createList: (db) => {
      const service = new OrgHierarchyLocationsService(createCrud(db));
      return (orgId, query) => service.listLocations(orgId, query);
    },
  },
  {
    label: "cost centers",
    kind: "COST_CENTER",
    createList: (db) => {
      const service = new OrgHierarchyCostCentersService(createCrud(db));
      return (orgId, query) => service.listCostCenters(orgId, query);
    },
  },
];

describe("hierarchy cursor lists", () => {
  it.each(listCases)(
    "$label applies server filters and bounded deterministic cursor pagination",
    async ({ kind, createList }) => {
      const {
        db,
        select,
        rowWhere,
        orderBy,
        limit,
      } = makeCursorDb();
      const list = createList(db);

      const result = await list(ORG_ID, {
        limit: 10,
        search: "north",
        status: "ACTIVE",
      });

      expect(result.pageInfo).toEqual({
        limit: 10,
        hasMore: false,
        nextCursor: null,
      });
      expect(result.data).toEqual([
        expect.objectContaining({
          id: UNIT_ID,
          orgId: ORG_ID,
          name: "North",
          status: "ACTIVE",
        }),
      ]);
      expect(select).toHaveBeenCalledTimes(1);
      expect(orderBy).toHaveBeenCalledTimes(1);
      expect(orderBy.mock.calls[0]).toHaveLength(2);
      expect(limit).toHaveBeenCalledWith(11);

      expect(sqlValues(rowWhere.mock.calls[0]?.[0])).toEqual(
        expect.arrayContaining([ORG_ID, kind, "%north%", "ACTIVE"]),
      );
    },
  );

  it("treats CURRENT as the non-archived lifecycle view", async () => {
    const { db, rowWhere } = makeCursorDb();
    const service = new OrgHierarchyBusinessUnitsService(createCrud(db));

    await service.listBusinessUnits(ORG_ID, {
      limit: 20,
      status: "CURRENT",
    });

    const values = sqlValues(rowWhere.mock.calls[0]?.[0]);
    expect(values).toContain("ARCHIVED");
    expect(values).not.toContain("CURRENT");
  });

  it("applies an opaque cursor and emits the next cursor only when another row exists", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      id: `00000000-0000-0000-0000-00000000000${index + 1}`,
      orgId: ORG_ID,
      parentId: null,
      name: `Unit ${index + 1}`,
      code: `UNIT_${index + 1}`,
      description: null,
      status: "ACTIVE" as const,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      deletedAt: null,
    }));
    const { db, rowWhere } = makeCursorDb(rows);
    const service = new OrgHierarchyBusinessUnitsService(createCrud(db));
    const cursor = encodeOrgUnitCursor({ name: "Before", id: UNIT_ID });

    const result = await service.listBusinessUnits(ORG_ID, {
      cursor,
      limit: 2,
      status: "ACTIVE",
    });

    expect(result.data).toHaveLength(2);
    expect(result.pageInfo).toEqual({
      limit: 2,
      hasMore: true,
      nextCursor: encodeOrgUnitCursor(rows[1] as { name: string; id: string }),
    });
    expect(sqlValues(rowWhere.mock.calls[0]?.[0])).toEqual(
      expect.arrayContaining(["before", UNIT_ID]),
    );
  });
});
