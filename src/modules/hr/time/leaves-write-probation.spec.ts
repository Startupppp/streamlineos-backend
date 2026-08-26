process.env.APP_URL ??= "http://localhost:1000";

import { BadRequestException } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ProbationCoverage } from "../lifecycle/probation-coverage";
import { LeavesWriteService } from "./leaves-write.service";
import { PROBATION_LEAVE_REFUSAL } from "./probation-leave-restriction";

const USER: CurrentUserContext = {
  userId: "employee-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
};

const REQUEST = {
  leaveTypeId: 1,
  startDate: "2026-03-01",
  endDate: "2026-03-03",
  reason: "Family event",
  priority: "MEDIUM" as const,
  isHalfDay: false,
};

function chainOf(methods: string[], resolved: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of methods) chain[method] = jest.fn(() => chain);
  chain[methods[methods.length - 1] as string] = jest.fn().mockResolvedValue(resolved);
  return chain;
}

function buildService(options: {
  policyRows: unknown[];
  coverage: ProbationCoverage;
}) {
  const insertedValues = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue([{ id: 42 }]),
  });
  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    select: jest.fn(() => chainOf(["from", "where", "for", "limit"], [{ balance: "10.00" }])),
    query: {
      leaveTypes: {
        findFirst: jest.fn().mockResolvedValue({ name: "Annual Leave", daysPerYear: 20 }),
      },
      leaveRequests: { findFirst: jest.fn().mockResolvedValue(undefined) },
      leaveBlackoutDates: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    insert: jest.fn().mockReturnValue({ values: insertedValues }),
  };
  const db = {
    query: { users: { findFirst: jest.fn().mockResolvedValue(undefined) } },
    select: jest.fn(() => chainOf(["from", "where", "limit"], options.policyRows)),
    transaction: jest.fn(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    ),
  };
  const probationCoverageOn = jest.fn().mockResolvedValue(options.coverage);
  const service = new LeavesWriteService(
    db as never,
    { logCritical: jest.fn() } as never,
    {} as never,
    { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) } as never,
    { startWorkflow: jest.fn().mockResolvedValue(undefined) } as never,
    { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
    { membersWithPermission: jest.fn().mockResolvedValue([]) } as never,
    { resolve: jest.fn().mockResolvedValue({ id: "manager-1", name: "Manager" }) } as never,
    { probationCoverageOn } as never,
  );
  return { service, insertedValues, probationCoverageOn };
}

describe("LeavesWriteService probation restriction", () => {
  it("refuses a restricted type for an employee inside probation, naming the policy", async () => {
    const { service, insertedValues } = buildService({
      policyRows: [{ probationRestricted: true }],
      coverage: "on-probation",
    });

    await expect(service.create(USER, REQUEST)).rejects.toThrow(BadRequestException);
    await expect(service.create(USER, REQUEST)).rejects.toThrow(PROBATION_LEAVE_REFUSAL);
    expect(insertedValues).not.toHaveBeenCalled();
  });

  it("books normally once the employee is past probation", async () => {
    const { service, insertedValues } = buildService({
      policyRows: [{ probationRestricted: true }],
      coverage: "past-probation",
    });

    await expect(service.create(USER, REQUEST)).resolves.toEqual({
      success: true,
      conflictWarning: undefined,
    });
    expect(insertedValues).toHaveBeenCalled();
  });

  it("books when probation was never recorded for the person", async () => {
    const { service, insertedValues } = buildService({
      policyRows: [{ probationRestricted: true }],
      coverage: "no-record",
    });

    await expect(service.create(USER, REQUEST)).resolves.toEqual({
      success: true,
      conflictWarning: undefined,
    });
    expect(insertedValues).toHaveBeenCalled();
  });

  it("never asks about probation when the policy flag is off", async () => {
    const { service, insertedValues, probationCoverageOn } = buildService({
      policyRows: [{ probationRestricted: false }],
      coverage: "on-probation",
    });

    await expect(service.create(USER, REQUEST)).resolves.toEqual({
      success: true,
      conflictWarning: undefined,
    });
    expect(probationCoverageOn).not.toHaveBeenCalled();
    expect(insertedValues).toHaveBeenCalled();
  });

  it("never asks about probation when no active policy exists for the leave type", async () => {
    const { service, probationCoverageOn } = buildService({
      policyRows: [],
      coverage: "on-probation",
    });

    await expect(service.create(USER, REQUEST)).resolves.toEqual({
      success: true,
      conflictWarning: undefined,
    });
    expect(probationCoverageOn).not.toHaveBeenCalled();
  });

  it("judges the dates requested, passing the leave start date rather than today", async () => {
    const { service, probationCoverageOn } = buildService({
      policyRows: [{ probationRestricted: true }],
      coverage: "past-probation",
    });

    await service.create(USER, REQUEST);

    expect(probationCoverageOn).toHaveBeenCalledWith(USER.orgId, USER.userId, "2026-03-01");
  });
});
