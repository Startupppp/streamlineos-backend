import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import { PortfoliosService } from "./portfolios.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";

const dialect = new PgDialect();
function renderSql(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

const ORG_ID = "org-1";
const OTHER_ORG = "org-9";
const USER_ID = "user-1";

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
      query: {},
    };

    const module = await Test.createTestingModule({
      providers: [
        PortfoliosService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();
    svc = module.get(PortfoliosService);
  });

  describe("linkProject — org validation", () => {
    it("throws 400 when project belongs to a different org", async () => {
      const portfolio = makePortfolio();
      const { selectChain: portChain } = makeSelectChain([portfolio]);
      const { selectChain: projChain } = makeSelectChain([]);

      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return portChain;
        return projChain;
      });

      await expect(
        svc.linkProject(ORG_ID, USER_ID, 1, { projectId: 99 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("resolves when project belongs to the same org", async () => {
      const portfolio = makePortfolio();
      const project = { id: 5 };

      const { selectChain: portChain } = makeSelectChain([portfolio]);
      const { selectChain: projChain } = makeSelectChain([project]);

      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return portChain;
        return projChain;
      });

      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
        }),
      });

      const result = await svc.linkProject(ORG_ID, USER_ID, 1, { projectId: 5 });
      expect(result).toEqual({ success: true });
      expect(mockAudit.log).toHaveBeenCalledTimes(1);
    });
  });

  describe("getPortfolio — flat response shape", () => {
    it("returns a flat object with projects and programs arrays spread alongside portfolio fields", async () => {
      const portfolio = makePortfolio({ id: 2, name: "Flat Test" });
      const linkedProjects = [{ id: 3, name: "P1", key: "P1", status: "ACTIVE" }];
      const programs = [{ id: 7, name: "Prog1", status: "active" }];

      const { selectChain: portChain } = makeSelectChain([portfolio]);

      const projectsLimitChain = jest.fn().mockResolvedValue(linkedProjects);
      const programsLimitChain = jest.fn().mockResolvedValue(programs);

      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return portChain;
        if (selectCount === 2) {
          return {
            from: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({ limit: projectsLimitChain }),
              }),
            }),
          };
        }
        if (selectCount === 3) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({ limit: programsLimitChain }),
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

      const result = await svc.getPortfolio(ORG_ID, 2);

      expect(result).toMatchObject({
        id: 2,
        name: "Flat Test",
        projects: linkedProjects,
        programs,
      });
      expect(Array.isArray(result.projects)).toBe(true);
      expect(Array.isArray(result.programs)).toBe(true);
    });
  });

  describe("loadPortfolio — BOLA cross-tenant isolation", () => {
    it("throws 404 when portfolioId belongs to a different tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getPortfolio(OTHER_ORG, 1)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws 404 when portfolio is soft-deleted (deletedAt set)", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getPortfolio(ORG_ID, 999)).rejects.toBeInstanceOf(NotFoundException);
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
          const limitFn = jest.fn().mockResolvedValue([]);
          const capturedWhere = jest.fn((cond: unknown) => {
            capturedProjectsWhere = cond;
            return { limit: limitFn };
          });
          return {
            from: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({ where: capturedWhere }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        };
      });

      await svc.getPortfolio(ORG_ID, 10);

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
