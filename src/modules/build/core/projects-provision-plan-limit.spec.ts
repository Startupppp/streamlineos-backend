jest.mock("../email/app-url", () => ({ appUrl: "https://test.example.com" }));

import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ProjectsProvisionService } from "./projects-provision.service";
import { PlanLimitsService } from "../../billing/plan-limits.service";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { ProjectsEmailService } from "./projects-email.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { CreateProjectInput } from "./dto/projects.schemas";

const ORG_ID = "org-abc";
const CREATOR_ID = "user-xyz";

const MINIMAL_INPUT: CreateProjectInput = {
  name: "Test Project",
};

function buildMockDb() {
  const insertChain = {
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 1, key: "TST-001", orgId: ORG_ID, name: "Test Project" }]),
  };
  return {
    transaction: jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: jest.fn().mockReturnValue(insertChain),
      }),
    ),
  };
}

describe("ProjectsProvisionService.createProject — plan limit enforcement", () => {
  let svc: ProjectsProvisionService;
  let mockDb: ReturnType<typeof buildMockDb>;
  let mockPlanLimits: { assertWithinLimit: jest.Mock };

  beforeEach(async () => {
    jest.resetAllMocks();
    mockDb = buildMockDb();
    mockPlanLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        ProjectsProvisionService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
        { provide: CacheService, useValue: { invalidatePattern: jest.fn().mockResolvedValue(undefined) } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: ProjectsEmailService,
          useValue: { notifyProjectMembers: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    svc = module.get(ProjectsProvisionService);
  });

  it("calls assertWithinLimit(orgId, 'projects') before starting the transaction", async () => {
    await svc.createProject(ORG_ID, CREATOR_ID, MINIMAL_INPUT);

    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledWith(ORG_ID, "projects");
    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledTimes(1);
  });

  it("calls assertWithinLimit before the DB transaction (transaction not called when limit exceeded)", async () => {
    const err = new ForbiddenException("Your Free plan allows 2 projects. Upgrade your plan to add more.");
    mockPlanLimits.assertWithinLimit.mockRejectedValueOnce(err);

    await expect(svc.createProject(ORG_ID, CREATOR_ID, MINIMAL_INPUT)).rejects.toBe(err);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("propagates ForbiddenException from assertWithinLimit without wrapping", async () => {
    const err = new ForbiddenException("Upgrade required");
    mockPlanLimits.assertWithinLimit.mockRejectedValueOnce(err);

    const thrown = await svc.createProject(ORG_ID, CREATOR_ID, MINIMAL_INPUT).catch((e: unknown) => e);
    expect(thrown).toBe(err);
    expect(thrown).toBeInstanceOf(ForbiddenException);
  });
});
