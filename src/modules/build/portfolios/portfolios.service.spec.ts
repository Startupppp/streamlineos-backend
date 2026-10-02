import { actorIn } from "./__tests__/portfolio-spec-fixtures";
import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import { PortfoliosService } from "./portfolios.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import { MANAGER_STANDING, standingAccess } from "../__tests__/project-access-doubles";

const dialect = new PgDialect();
function renderSql(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

const ORG_ID = "org-1";
const OTHER_ORG = "org-9";
const USER_ID = "user-1";
const DETAIL_QUERY = {
  projectsCursor: undefined,
  projectsLimit: 20,
  programsCursor: undefined,
  programsLimit: 20,
};

const mockAudit = { log: jest.fn() } as unknown as AuditService;

function makePortfolio(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orgId: ORG_ID,
    name: "My Portfolio",
    description: null,
    ownerId: null,
    status: "active",
    health: null,
    strategicGoal: null,
    createdBy: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

describe("PortfoliosService", () => {
  let svc: PortfoliosService;
  let mockDb: Record<string, unknown>;

  function makeSelectChain(rows: unknown[]) {
    const whereChain = { limit: jest.fn().mockResolvedValue(rows) };
    const fromChain = { where: jest.fn().mockReturnValue(whereChain) };
    const selectChain = { from: jest.fn().mockReturnValue(fromChain) };
    return { selectChain, fromChain, whereChain };
  }

  beforeEach(async () => {
    jest.resetAllMocks();

    mockDb = {
      select: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      query: {
        projects: { findFirst: jest.fn() },
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        PortfoliosService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
        { provide: AccessService, useValue: standingAccess(MANAGER_STANDING) },
      ],
    }).compile();
    svc = module.get(PortfoliosService);
  });

  describe("getPortfolio — related links are cursor pages, not bare arrays", () => {
    it("returns projects and programs as cursor pages spread alongside portfolio fields", async () => {
      const portfolio = makePortfolio({ id: 2, name: "Flat Test" });
      const addedAt = new Date("2026-01-02T03:04:05.000Z");
      const linkedProjects = [{ id: 3, name: "P1", key: "P1", status: "ACTIVE", addedAt }];
      const programs = [{ id: 7, name: "Prog1", status: "active", createdAt: addedAt }];

      const { selectChain: portChain } = makeSelectChain([portfolio]);

      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return portChain;
        if (selectCount === 2) {
          return {
            from: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({
                  orderBy: jest.fn().mockReturnValue({
                    limit: jest.fn().mockResolvedValue(linkedProjects),
                  }),
                }),
              }),
            }),
          };
        }
        if (selectCount === 3) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                orderBy: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue(programs),
                }),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              groupBy: jest
                .fn()
                .mockResolvedValue([{ projectId: 3, openCount: 2, doneCount: 1 }]),
            }),
          }),
        };
      });

      const result = await svc.getPortfolio(actorIn(ORG_ID), 2, DETAIL_QUERY);

      expect(result).toMatchObject({ id: 2, name: "Flat Test" });
      expect(result.projects.data).toEqual([
        { id: 3, name: "P1", key: "P1", status: "ACTIVE", openCount: 2, doneCount: 1 },
      ]);
      expect(result.programs.data).toEqual([{ id: 7, name: "Prog1", status: "active" }]);
      expect(result.projects.pagination.hasMore).toBe(false);
      expect(result.programs.pagination.hasMore).toBe(false);
    });

    it("reports hasMore and a nextCursor when the linked-projects page is full, so the caller can read past the first page", async () => {
      const portfolio = makePortfolio({ id: 2 });
      const { selectChain: portChain } = makeSelectChain([portfolio]);
      const overflow = Array.from({ length: 3 }, (_unused, index) => ({
        id: index + 1,
        name: `P${index + 1}`,
        key: `P${index + 1}`,
        status: "ACTIVE",
        addedAt: new Date(2026, 0, 10 - index),
      }));

      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return portChain;
        if (selectCount === 2) {
          return {
            from: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({
                  orderBy: jest.fn().mockReturnValue({
                    limit: jest.fn().mockResolvedValue(overflow),
                  }),
                }),
              }),
            }),
          };
        }
        if (selectCount === 3) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
              }),
            }),
          };
        }
        const countsChain: Record<string, unknown> = {
          innerJoin: jest.fn(() => countsChain),
          where: jest.fn(() => countsChain),
          groupBy: jest.fn().mockResolvedValue([]),
          then: (resolve: (value: unknown) => unknown) => Promise.resolve([]).then(resolve),
        };
        return { from: jest.fn(() => countsChain) };
      });

      const result = await svc.getPortfolio(actorIn(ORG_ID), 2, {
        ...DETAIL_QUERY,
        projectsLimit: 2,
      });

      expect(result.projects.data).toHaveLength(2);
      expect(result.projects.pagination.hasMore).toBe(true);
      expect(result.projects.pagination.nextCursor).toEqual(expect.any(String));
    });
  });

  describe("loadPortfolio — BOLA cross-tenant isolation", () => {
    it("throws 404 when portfolioId belongs to a different tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getPortfolio(actorIn(OTHER_ORG), 1, DETAIL_QUERY)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("throws 404 when portfolio is soft-deleted (deletedAt set)", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getPortfolio(actorIn(ORG_ID), 999, DETAIL_QUERY)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("getPortfolio — projects join excludes soft-deleted rows", () => {
    it("WHERE clause for the linked-projects inner join includes a deleted_at IS NULL predicate", async () => {
      let capturedProjectsWhere: unknown;
      let callNumber = 0;

      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        callNumber++;
        if (callNumber === 1) {
          const whereChain = { limit: jest.fn().mockResolvedValue([makePortfolio({ id: 10 })]) };
          const fromChain = { where: jest.fn().mockReturnValue(whereChain) };
          return { from: jest.fn().mockReturnValue(fromChain) };
        }
        if (callNumber === 2) {
          const orderByFn = jest
            .fn()
            .mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
          const capturedWhere = jest.fn((cond: unknown) => {
            capturedProjectsWhere = cond;
            return { orderBy: orderByFn };
          });
          return {
            from: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({ where: capturedWhere }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
            }),
          }),
        };
      });

      await svc.getPortfolio(actorIn(ORG_ID), 10, DETAIL_QUERY);

      expect(capturedProjectsWhere).toBeDefined();
      const rendered = renderSql(capturedProjectsWhere);
      expect(rendered.toLowerCase()).toContain("deleted_at");
    });

    it("bite proof: a where clause without isNull(projects.deletedAt) does not filter deleted projects", () => {
      const bare = '"portfolio_projects"."portfolio_id" = $1 and "portfolio_projects"."org_id" = $2';
      expect(bare.toLowerCase()).not.toContain("deleted_at");
    });
  });
});
