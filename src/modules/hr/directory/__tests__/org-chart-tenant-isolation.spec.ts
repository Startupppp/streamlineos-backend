import { OrgChartService } from "../org-chart.service";
import type { Db } from "../../../db/drizzle.module";
import type { EmploymentFactsService } from "../../../directory/employment-facts.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ATTACKER_ORG = "org-attacker-orgchart";
const VICTIM_ORG = "org-victim-orgchart";

function makeSelectDb(rows: unknown[] = []): { db: Db; where: jest.Mock } {
  const where = jest.fn();
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    where,
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
    then: (resolve: (v: unknown) => void) => resolve(rows),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.innerJoin as jest.Mock).mockReturnValue(builder);
  (builder.leftJoin as jest.Mock).mockReturnValue(builder);
  (builder.where as jest.Mock).mockReturnValue(builder);
  (builder.orderBy as jest.Mock).mockReturnValue(builder);
  const db = {
    select: jest.fn().mockReturnValue(builder),
  } as unknown as Db;
  return { db, where };
}

function makeEmploymentDep(): EmploymentFactsService {
  return {
    getDirectReportUserIds: jest.fn().mockResolvedValue([]),
    getFactsBatch: jest.fn().mockResolvedValue(new Map()),
    getFacts: jest.fn().mockResolvedValue({ managerUserId: null, departmentId: null, locationId: null }),
  } as unknown as EmploymentFactsService;
}

describe("OrgChartService — cross-tenant isolation", () => {
  it("getOrgChart scopes members to the requesting org — attacker org sees empty chart (cross-tenant isolation)", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new OrgChartService(db, makeEmploymentDep());

    const result = await svc.getOrgChart(
      ATTACKER_ORG,
      "user-attacker",
      "all",
      { limit: 20 },
    );

    expect(result.data).toEqual([]);
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(VICTIM_ORG);
  });

  it("getOrgChart WHERE clause includes orgId for org membership — different org users are excluded", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new OrgChartService(db, makeEmploymentDep());

    await svc.getOrgChart(ATTACKER_ORG, "user-x", "all", { limit: 10 });

    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER_ORG);
  });

  it("getOrgChart with search query still scopes to requesting org — wrong org predicate is never absent (tenant isolation)", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new OrgChartService(db, makeEmploymentDep());

    await svc.getOrgChart(ATTACKER_ORG, "user-x", "all", { limit: 10, search: "Alice" });

    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER_ORG);
  });
});
