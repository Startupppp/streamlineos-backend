import type { AuditService } from "../../../common/audit/audit.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { Db } from "../../../db/drizzle.module";
import type { ListQueryInput } from "./dto/org-hierarchy.schemas";
import { OrgHierarchyBranchesService } from "./org-hierarchy-branches.service";
import { OrgHierarchyBusinessUnitsService } from "./org-hierarchy-business-units.service";
import { OrgHierarchyCostCentersService } from "./org-hierarchy-cost-centers.service";
import { OrgHierarchyDepartmentsService } from "./org-hierarchy-departments.service";
import { OrgHierarchyLocationsService } from "./org-hierarchy-locations.service";
import { OrgHierarchyTeamsService } from "./org-hierarchy-teams.service";

const ORG_ID = "org-1";
const UNIT_ID = "00000000-0000-0000-0000-000000000001";

type PageResult = {
  data: unknown[];
  total: number;
  page: number;
  limit: number;
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

function makePaginatedDb() {
  const row = {
    id: UNIT_ID,
    orgId: ORG_ID,
    parentId: null,
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
  const offset = jest.fn().mockResolvedValue([row]);
  const limit = jest.fn().mockReturnValue({ offset });
  const orderBy = jest.fn().mockReturnValue({ limit });
  const rowWhere = jest.fn().mockReturnValue({ orderBy });
  const countWhere = jest.fn().mockResolvedValue([{ count: 37 }]);
  const rowFrom = jest.fn().mockReturnValue({ where: rowWhere });
  const countFrom = jest.fn().mockReturnValue({ where: countWhere });
  const select = jest
    .fn()
    .mockImplementation((selection: Record<string, unknown>) => ({
      from: Object.prototype.hasOwnProperty.call(selection, "count")
        ? countFrom
        : rowFrom,
    }));

  return {
    db: { select } as unknown as Db,
    select,
    rowWhere,
    countWhere,
    orderBy,
    limit,
    offset,
  };
}

const cache = {} as CacheService;
const audit = {} as AuditService;

const listCases: Array<{
  label: string;
  kind: string;
  createList: (db: Db) => ListFunction;
}> = [
  {
    label: "business units",
    kind: "BUSINESS_UNIT",
    createList: (db) => {
      const service = new OrgHierarchyBusinessUnitsService(db, cache, audit);
      return (orgId, query) => service.listBusinessUnits(orgId, query);
    },
  },
  {
    label: "branches",
    kind: "BRANCH",
    createList: (db) => {
      const service = new OrgHierarchyBranchesService(db, cache, audit);
      return (orgId, query) => service.listOrgBranches(orgId, query);
    },
  },
  {
    label: "departments",
    kind: "DEPARTMENT",
    createList: (db) => {
      const service = new OrgHierarchyDepartmentsService(db, cache, audit);
      return (orgId, query) => service.listDepartments(orgId, query);
    },
  },
  {
    label: "teams",
    kind: "TEAM",
    createList: (db) => {
      const service = new OrgHierarchyTeamsService(db, cache, audit);
      return (orgId, query) => service.listTeams(orgId, query);
    },
  },
  {
    label: "locations",
    kind: "LOCATION",
    createList: (db) => {
      const service = new OrgHierarchyLocationsService(db, cache, audit);
      return (orgId, query) => service.listLocations(orgId, query);
    },
  },
  {
    label: "cost centers",
    kind: "COST_CENTER",
    createList: (db) => {
      const service = new OrgHierarchyCostCentersService(db, cache, audit);
      return (orgId, query) => service.listCostCenters(orgId, query);
    },
  },
];

describe("hierarchy list pagination", () => {
  it.each(listCases)(
    "$label applies server filters and deterministic offset pagination",
    async ({ kind, createList }) => {
      const {
        db,
        select,
        rowWhere,
        countWhere,
        orderBy,
        limit,
        offset,
      } = makePaginatedDb();
      const list = createList(db);

      const result = await list(ORG_ID, {
        page: 3,
        limit: 10,
        search: "north",
        status: "ACTIVE",
      });

      expect(result).toMatchObject({ total: 37, page: 3, limit: 10 });
      expect(result.data).toEqual([
        expect.objectContaining({
          id: UNIT_ID,
          orgId: ORG_ID,
          name: "North",
          status: "ACTIVE",
        }),
      ]);
      expect(select).toHaveBeenCalledTimes(2);
      expect(orderBy).toHaveBeenCalledTimes(1);
      expect(orderBy.mock.calls[0]).toHaveLength(2);
      expect(limit).toHaveBeenCalledWith(10);
      expect(offset).toHaveBeenCalledWith(20);
      expect(countWhere).toHaveBeenCalledWith(rowWhere.mock.calls[0]?.[0]);

      expect(sqlValues(rowWhere.mock.calls[0]?.[0])).toEqual(
        expect.arrayContaining([ORG_ID, kind, "%north%", "ACTIVE"]),
      );
    },
  );

  it("treats CURRENT as the non-archived lifecycle view", async () => {
    const { db, rowWhere } = makePaginatedDb();
    const service = new OrgHierarchyBusinessUnitsService(db, cache, audit);

    await service.listBusinessUnits(ORG_ID, {
      page: 1,
      limit: 20,
      status: "CURRENT",
    });

    const values = sqlValues(rowWhere.mock.calls[0]?.[0]);
    expect(values).toContain("ARCHIVED");
    expect(values).not.toContain("CURRENT");
  });
});
