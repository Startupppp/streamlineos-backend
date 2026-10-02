import { NotFoundException } from "@nestjs/common";
import * as projectAccess from "../core/project-crud/project-access";
import { ProgramsService } from "./programs.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { Test } from "@nestjs/testing";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const mockAudit = { log: jest.fn() } as unknown as AuditService;

function makeProgramRow() {
  return {
    id: 1, orgId: ORG_ID, name: "Prog", description: null, ownerId: null,
    portfolioId: null, status: "active", health: null, strategicGoal: null,
    createdBy: USER_ID, createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
  };
}

describe("ProgramsService.linkProject — delegates project-org check to assertProjectInOrg", () => {
  let svc: ProgramsService;
  let mockDb: Record<string, unknown>;

  beforeEach(async () => {
    jest.resetAllMocks();
    const whereChain = { limit: jest.fn().mockResolvedValue([makeProgramRow()]) };
    const fromChain = { where: jest.fn().mockReturnValue(whereChain) };
    const selectChain = { from: jest.fn().mockReturnValue(fromChain) };
    mockDb = {
      select: jest.fn().mockReturnValue(selectChain),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockResolvedValue(undefined) }),
      }),
      query: { projects: { findFirst: jest.fn() } },
    };
    const module = await Test.createTestingModule({
      providers: [
        ProgramsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();
    svc = module.get(ProgramsService);
  });

  it("calls assertProjectInOrg and propagates its NotFoundException (project not in org — 404, not 400)", async () => {
    jest.spyOn(projectAccess, "assertProjectInOrg").mockRejectedValue(new NotFoundException("Project not found"));

    await expect(svc.linkProject(ORG_ID, USER_ID, 1, { projectId: 99 })).rejects.toBeInstanceOf(NotFoundException);
    expect(projectAccess.assertProjectInOrg).toHaveBeenCalledWith(expect.anything(), ORG_ID, 99);
  });

  it("calls assertProjectInOrg and succeeds when project exists in org", async () => {
    jest.spyOn(projectAccess, "assertProjectInOrg").mockResolvedValue(undefined);

    const result = await svc.linkProject(ORG_ID, USER_ID, 1, { projectId: 5 });
    expect(result).toEqual({ success: true });
    expect(projectAccess.assertProjectInOrg).toHaveBeenCalledWith(expect.anything(), ORG_ID, 5);
  });
});
