process.env.APP_URL ??= "http://localhost:1000";

import { Test } from "@nestjs/testing";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { OrgStructureService } from "./org-structure.service";
import { OrgChartService } from "./org-chart.service";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { ScopedRead } from "../../access/scoped-read";
import { orgChartPageSchema } from "./dto/directory-response.schemas";

/**
 * V-026. The root page of the org chart is "everyone with no VISIBLE manager",
 * which mixes the founder with every hire nobody has assigned a manager to yet.
 * The frontend split those roots on `hasDirectReports`, so an UNMANAGED hire
 * who happens to have reports of their own rendered as a second CEO beside the
 * founder — a tree the organisation does not have.
 *
 * The row carried nothing that could tell them apart. `isOwner` is a fact this
 * query already joins, and this pins that it reaches the payload and survives
 * the response contract.
 */
describe("the org chart says which root is the owner", () => {
  function selectPage(rows: unknown[]) {
    const chain: Record<string, jest.Mock> = {
      from: jest.fn(),
      innerJoin: jest.fn(),
      leftJoin: jest.fn(),
      where: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn().mockResolvedValue(rows),
    };
    for (const key of ["from", "innerJoin", "leftJoin", "where", "orderBy"])
      chain[key]!.mockReturnValue(chain);
    return chain;
  }

  function row(overrides: Record<string, unknown>) {
    return {
      cursorName: "x",
      name: "X",
      role: "MEMBER",
      designation: null,
      image: null,
      departmentId: null,
      departmentName: null,
      hasDirectReports: false,
      isOwner: false,
      ...overrides,
    };
  }

  async function serviceFor(rows: unknown[]) {
    const query = selectPage(rows);
    const module = await Test.createTestingModule({
      providers: [
        OrgChartService,
        OrgStructureService,
        { provide: DRIZZLE, useValue: { select: jest.fn().mockReturnValue(query) } },
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
    return { service: module.get(OrgStructureService), query };
  }

  it("marks the founder and does not mark an unmanaged hire who happens to have reports", async () => {
    const { service } = await serviceFor([
      row({ id: "founder", cursorName: "asha", name: "Asha", isOwner: true, hasDirectReports: true }),
      // The fake second CEO: nobody assigned them a manager, and they lead a
      // team, so the old payload made them indistinguishable from the founder.
      row({ id: "unmanaged", cursorName: "ben", name: "Ben", hasDirectReports: true }),
      row({ id: "loner", cursorName: "zoe", name: "Zoe" }),
    ]);

    const result = await service.getOrgChart(ScopedRead.of("org-1", "actor-1", "all"), {
      limit: 10,
    });

    expect(result.data.map((node) => [node.id, node.isOwner])).toEqual([
      ["founder", true],
      ["unmanaged", false],
      ["loner", false],
    ]);
    // Paired with the above: `hasDirectReports` on its own still cannot tell
    // them apart, which is exactly why the extra field was needed.
    expect(result.data.filter((node) => node.hasDirectReports)).toHaveLength(2);
  });

  it("satisfies the declared response contract with the field present", async () => {
    const { service } = await serviceFor([row({ id: "founder", isOwner: true })]);

    const result = await service.getOrgChart(ScopedRead.of("org-1", "actor-1", "all"), {
      limit: 10,
    });

    expect(() => orgChartPageSchema.parse(result)).not.toThrow();
  });

  it("treats a missing owner flag as not-owner rather than letting undefined reach the contract", async () => {
    // The column is non-null in the table, but a projection change is how it
    // would go missing — and `undefined` would 500 at the response schema
    // rather than degrade.
    const { service } = await serviceFor([
      { ...row({ id: "nobody" }), isOwner: undefined },
    ]);

    const result = await service.getOrgChart(ScopedRead.of("org-1", "actor-1", "all"), {
      limit: 10,
    });

    expect(result.data[0]?.isOwner).toBe(false);
    expect(() => orgChartPageSchema.parse(result)).not.toThrow();
  });
});
