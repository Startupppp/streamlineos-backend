jest.mock("../../../email/app-url", () => ({ appUrl: "https://test.example.com" }));

import { Test } from "@nestjs/testing";
import { ProjectsProvisionService } from "./projects-provision.service";
import { PlanLimitsService } from "../../../billing/core/plan-limits.service";
import { CacheService } from "../../../../common/cache/cache.service";
import { AuditService } from "../../../../common/audit/audit.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { CreateProjectInput } from "../dto/projects.schemas";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { PaymentRequiredException } from "../../../../common/http/api-exceptions";

const ORG_ID = "org-abc";
const CREATOR_ID = "user-xyz";

const MINIMAL_INPUT: CreateProjectInput = {
  name: "Test Project",
};

function buildMockTx() {
  const insertChain = {
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 1, key: "TST-001", orgId: ORG_ID, name: "Test Project" }]),
  };
  return {
    execute: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnValue(insertChain),
  };
}

function buildMockDb(txOverride?: ReturnType<typeof buildMockTx>) {
  const tx = txOverride ?? buildMockTx();
  const membershipRow = {
    id: 1,
    orgId: ORG_ID,
    userId: CREATOR_ID,
    role: "ADMIN",
    isOwner: true,
    status: "ACTIVE",
  };
  return {
    mockTx: tx,
    db: {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([membershipRow]),
        }),
      }),
      transaction: jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
        fn(tx),
      ),
    },
  };
}

describe("ProjectsProvisionService.createProject — atomic quota admission", () => {
  let svc: ProjectsProvisionService;
  let mockPlanLimits: { assertWithinLimit: jest.Mock };
  let tx: ReturnType<typeof buildMockTx>;

  beforeEach(async () => {
    jest.resetAllMocks();
    const built = buildMockDb();
    tx = built.mockTx;
    mockPlanLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        ProjectsProvisionService,
        { provide: DRIZZLE, useValue: built.db },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
        { provide: CacheService, useValue: { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    svc = module.get(ProjectsProvisionService);
  });

  it("calls assertWithinLimit inside the transaction with the tx executor and increment=1", async () => {
    await svc.createProject(ORG_ID, CREATOR_ID, MINIMAL_INPUT);

    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledWith(ORG_ID, "projects", 1, tx);
    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledTimes(1);
  });

  it("acquires the quota advisory lock before assertWithinLimit inside the transaction", async () => {
    const executeCalls: unknown[] = [];
    tx.execute.mockImplementation((arg: unknown) => {
      executeCalls.push(arg);
      return Promise.resolve([]);
    });
    let assertCalledAfterLock = false;
    mockPlanLimits.assertWithinLimit.mockImplementation(() => {
      assertCalledAfterLock = executeCalls.length >= 1;
      return Promise.resolve();
    });

    await svc.createProject(ORG_ID, CREATOR_ID, MINIMAL_INPUT);

    expect(executeCalls.length).toBeGreaterThanOrEqual(1);
    expect(assertCalledAfterLock).toBe(true);
  });

  it("when limit is exceeded the transaction runs but no project insert occurs", async () => {
    const err = new PaymentRequiredException({
      code: "QUOTA_EXCEEDED",
      message: "Your Free plan allows 2 projects.",
      details: { limitKey: "projects", used: 2, limit: 2, upgradePath: "/settings/billing" },
    });
    mockPlanLimits.assertWithinLimit.mockRejectedValueOnce(err);

    await expect(svc.createProject(ORG_ID, CREATOR_ID, MINIMAL_INPUT)).rejects.toBe(err);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("propagates PaymentRequiredException from assertWithinLimit without wrapping", async () => {
    const err = new PaymentRequiredException({
      code: "QUOTA_EXCEEDED",
      message: "Upgrade required",
      details: { limitKey: "projects", used: 2, limit: 2, upgradePath: "/settings/billing" },
    });
    mockPlanLimits.assertWithinLimit.mockRejectedValueOnce(err);

    const thrown = await svc.createProject(ORG_ID, CREATOR_ID, MINIMAL_INPUT).catch((e: unknown) => e);
    expect(thrown).toBe(err);
    expect(thrown).toBeInstanceOf(PaymentRequiredException);
  });
});
