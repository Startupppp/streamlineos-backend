import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PortfoliosService } from "./portfolios.service";
import { AuditService } from "../../common/audit/audit.service";
import { DRIZZLE } from "../../db/drizzle.constants";

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
      (mockDb as { select: jest.Mock }).select.mockReturnValueOnce(portChain);

      const projectsWhereChain = jest.fn().mockResolvedValue(linkedProjects);
      const programsWhereChain = jest.fn().mockResolvedValue(programs);

      let selectCount = 0;
      const originalSelect = (mockDb as { select: jest.Mock }).select;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) return portChain;
        if (selectCount === 2) {
          return {
            from: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: projectsWhereChain,
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: programsWhereChain,
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
});
