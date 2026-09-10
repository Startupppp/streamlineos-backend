jest.mock("../../../common/rbac/assert-may-grant-role", () => ({
  assertMayGrantRole: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../common/org/sync-org-unit-placement", () => ({
  syncOrgUnitPlacement: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../common/rbac/sync-structural-role", () => ({
  syncStructuralRoleAssignment: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../common/auth/membership-state.service", () => ({
  bustMembershipStatusCache: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./salary-profile-seed.helper", () => ({
  seedEmployeeSalaryProfile: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../common/hr/sync-canonical-employment-fields", () => ({
  syncCanonicalEmploymentFields: jest.fn().mockResolvedValue(undefined),
}));

import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { EmployeeOnboardingService } from "./employee-onboarding.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { EmailService } from "../../email/email.service";
import { AutomationService } from "../../automation/automation.service";
import { WebhooksDispatchService } from "../../webhooks/webhooks-dispatch.service";
import { PersonEmploymentSyncService } from "../core/person-employment-sync.service";
import { AccessService } from "../../access/access.service";
import { MembershipAdmissionService } from "../../organization/core/membership-admission.service";

const ORG_ID = "org-limit-test";
const ACTOR = {
  userId: "actor-1",
  orgId: ORG_ID,
  isOrgOwner: true,
  role: "ADMIN",
  sessionId: "session-1",
  tokenScopes: null,
  principal: { kind: "human-session" as const, membershipId: 1, isOrgOwner: true },
};
const NEW_USER = {
  id: "u-new",
  email: "jane@example.com",
  name: "Jane Doe",
  firstName: "Jane",
  lastName: "Doe",
  isActive: true,
};
const INPUT = { email: "jane@example.com", firstName: "Jane", lastName: "Doe", designation: "Engineer" };

function buildTx() {
  return {
    execute: jest.fn().mockResolvedValue([{}]),
    query: { users: { findFirst: jest.fn().mockResolvedValue(NEW_USER) } },
    insert: jest
      .fn()
      .mockImplementationOnce(() => ({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([NEW_USER]),
        }),
      }))
      .mockImplementation(() => ({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 42 }]),
        }),
      })),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    }),
  };
}

describe("EmployeeOnboardingService.onboardEmployee — seat-limit ordering", () => {
  let svc: EmployeeOnboardingService;
  let tx: ReturnType<typeof buildTx>;
  let mockPlanLimits: { assertWithinLimit: jest.Mock };

  beforeEach(async () => {
    jest.resetAllMocks();
    tx = buildTx();
    mockPlanLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };

    const mockDb = {
      query: {
        users: { findFirst: jest.fn().mockResolvedValue(null) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      select: jest.fn().mockImplementation(() => {
        const chain: Record<string, unknown> = {};
        const passthrough = () => chain;
        chain["from"] = passthrough;
        chain["innerJoin"] = passthrough;
        chain["where"] = passthrough;
        chain["limit"] = () => Promise.resolve([]);
        return chain;
      }),
      transaction: jest.fn().mockImplementation(
        (fn: (t: ReturnType<typeof buildTx>) => Promise<unknown>) => fn(tx),
      ),
    };

    const module = await Test.createTestingModule({
      providers: [
        EmployeeOnboardingService,
        MembershipAdmissionService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
        {
          provide: SeatLedgerService,
          useValue: { recordSeatEvents: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: CacheService,
          useValue: {
            invalidate: jest.fn().mockResolvedValue(undefined),
            invalidateNamespace: jest.fn().mockResolvedValue(undefined),
            invalidateForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
            cached: jest.fn(),
          },
        },
        {
          provide: AuditService,
          useValue: { logCritical: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: EmailService, useValue: {} },
        {
          provide: AutomationService,
          useValue: { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: WebhooksDispatchService,
          useValue: { dispatch: jest.fn() },
        },
        {
          provide: PersonEmploymentSyncService,
          useValue: { ensureFromUser: jest.fn().mockResolvedValue({ employmentId: 99 }) },
        },
        {
          provide: AccessService,
          useValue: { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()) },
        },
      ],
    }).compile();

    svc = module.get(EmployeeOnboardingService);
  });

  it("calls assertWithinLimit before the first insert when onboarding a new user", async () => {
    await svc.onboardEmployee(ACTOR, INPUT);

    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalled();
    expect(mockPlanLimits.assertWithinLimit.mock.invocationCallOrder[0]).toBeLessThan(
      tx.insert.mock.invocationCallOrder[0],
    );
  });

  it("passes the transaction executor to assertWithinLimit", async () => {
    await svc.onboardEmployee(ACTOR, INPUT);

    const [orgArg, keyArg, , txArg] = mockPlanLimits.assertWithinLimit.mock.calls[0];
    expect(orgArg).toBe(ORG_ID);
    expect(keyArg).toBe("members");
    expect(txArg).toBe(tx);
  });

  it("does not insert when quota is exhausted — new user path", async () => {
    mockPlanLimits.assertWithinLimit.mockRejectedValueOnce(
      new ForbiddenException("Your plan limit has been reached."),
    );

    await expect(svc.onboardEmployee(ACTOR, INPUT)).rejects.toBeInstanceOf(ForbiddenException);

    expect(tx.insert).not.toHaveBeenCalled();
  });
});
