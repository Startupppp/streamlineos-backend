process.env.APP_URL ??= "http://localhost:1000";

import * as applyScopeModule from "../../access/apply-scope";
import { Test } from "@nestjs/testing";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { decodeOrgChartCursor } from "./org-chart-cursor";
import { OrgStructureService } from "./org-structure.service";
import { OrgChartService } from "./org-chart.service";
import { EmploymentFactsService } from "../../directory/employment-facts.service";

function selectPage(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

describe("OrgStructureService organization chart", () => {
  afterEach(() => jest.restoreAllMocks());

  async function createService(db: object): Promise<OrgStructureService> {
    const module = await Test.createTestingModule({
      providers: [
        OrgChartService,
        OrgStructureService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: {} },
        {
          provide: EmploymentFactsService,
          useValue: {
            getFactsBatch: jest.fn().mockResolvedValue(new Map()),
            getDirectReportUserIds: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();
    return module.get(OrgStructureService);
  }

  it("returns one bounded stable cursor page and applies DataScope inside SQL", async () => {
    const rows = [
      {
        id: "employee-1",
        cursorName: "ada",
        name: "Ada",
        role: "MEMBER",
        designation: "Engineer",
        image: null,
        departmentId: "department-1",
        departmentName: "Engineering",
        hasDirectReports: true,
      },
      {
        id: "employee-2",
        cursorName: "ben",
        name: "Ben",
        role: "MEMBER",
        designation: null,
        image: null,
        departmentId: null,
        departmentName: null,
        hasDirectReports: false,
      },
      {
        id: "employee-3",
        cursorName: "zoe",
        name: "Zoe",
        role: "MEMBER",
        designation: null,
        image: null,
        departmentId: null,
        departmentName: null,
        hasDirectReports: false,
      },
    ];
    const query = selectPage(rows);
    const db = { select: jest.fn().mockReturnValue(query) };
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = await createService(db);

    const result = await service.getOrgChart("org-1", "actor-1", "team", {
      limit: 2,
    });

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(query.limit).toHaveBeenCalledWith(3);
    expect(scopeSpy).toHaveBeenCalledTimes(3);
    expect(scopeSpy).toHaveBeenCalledWith(
      "team",
      "org-1",
      "actor-1",
      expect.objectContaining({ ownerColumn: expect.anything() }),
    );
    expect(result.data).toHaveLength(2);
    expect(result.pageInfo.hasMore).toBe(true);
    expect(decodeOrgChartCursor(result.pageInfo.nextCursor ?? "")).toEqual({
      name: "ben",
      employeeUserId: "employee-2",
    });
  });

  it("requires the requested parent and its direct reports to share the caller's scope", async () => {
    const query = selectPage([]);
    const db = { select: jest.fn().mockReturnValue(query) };
    const scopeSpy = jest.spyOn(applyScopeModule, "applyScope");
    const service = await createService(db);

    await service.getOrgChart("org-1", "actor-1", "own", {
      parentId: "manager-1",
      limit: 20,
    });

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(query.limit).toHaveBeenCalledWith(21);
    expect(scopeSpy).toHaveBeenCalledTimes(4);
  });
});
