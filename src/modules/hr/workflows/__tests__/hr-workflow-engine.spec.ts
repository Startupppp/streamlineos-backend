import { Test, type TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { HrWorkflowEngineService } from "../hr-workflow-engine.service";
import { HrWorkflowApproverService } from "../hr-workflow-approver.service";
import { HrWorkflowStepRunnerService } from "../hr-workflow-step-runner.service";
import { AccessService } from "../../../access/access.service";
import { EmploymentFactsService } from "../../../directory/employment-facts.service";
import { ApprovalAuthorityService } from "../../../directory/approval-authority.service";
import type { ApprovalRoute } from "../../../directory/approval-authority.types";

function makeSelectChain(results: unknown[][] = []) {
  let callIndex = 0;
  const obj: Record<string, jest.Mock> = {};
  const methods = ["select", "from", "where", "orderBy", "innerJoin"];
  const limitMock = jest.fn().mockImplementation(() => {
    const r = results[callIndex] ?? [];
    callIndex++;
    return Promise.resolve(r);
  });
  for (const m of methods) {
    obj[m] = jest.fn().mockReturnValue(obj);
  }
  obj["limit"] = limitMock;
  return obj;
}

function makeDb(selectResults: unknown[][] = [], insertResult: unknown[] = [{ id: 100, status: "approved" }]) {
  const chain = makeSelectChain(selectResults);

  const returningMock = jest.fn().mockResolvedValue(insertResult);
  const insertChain = {
    values: jest.fn().mockReturnValue({
      returning: returningMock,
      onConflictDoNothing: jest.fn().mockReturnValue({ returning: returningMock }),
    }),
  };
  const updateChain = {
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
    }),
  };

  return {
    select: jest.fn().mockReturnValue(chain),
    from: chain.from,
    where: chain.where,
    limit: chain.limit,
    insert: jest.fn().mockReturnValue(insertChain),
    values: insertChain.values,
    returning: returningMock,
    update: jest.fn().mockReturnValue(updateChain),
    set: updateChain.set,
    orderBy: chain.orderBy,
    innerJoin: chain.innerJoin,
    transaction: jest.fn(),
    _chain: chain,
    _returning: returningMock,
  };
}

function buildInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orgId: "org1",
    definitionId: 10,
    definitionSnapshot: { steps: [] },
    objectType: "leave_request",
    objectId: "lr-1",
    requestedBy: "requester",
    subjectEmployeeId: "emp1",
    context: {},
    status: "in_progress",
    currentStepOrder: 1,
    dueAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeAccessService() {
  return {
    membersWithPermission: jest.fn().mockResolvedValue([]),
  } as unknown as AccessService;
}

function makeEmploymentFacts(overrides: Partial<{ managerUserId: string | null; departmentId: string | null }> = {}) {
  return {
    userId: "emp1",
    employmentId: null,
    employeeNumber: null,
    designation: null,
    joiningDate: null,
    departmentId: overrides.departmentId ?? null,
    locationId: null,
    managerUserId: overrides.managerUserId ?? null,
  };
}

function makeRoute(overrides: Partial<ApprovalRoute> = {}): ApprovalRoute {
  return {
    kind: "leave",
    subjectUserId: "emp1",
    permission: "hr:workflows:approve",
    resolvedAt: "2026-09-21T00:00:00.000Z",
    rung: "reporting_manager",
    assignedTo: { userId: "manager-1", membershipId: 5, name: "Manager", email: "manager@example.com", designation: null },
    approver: { userId: "manager-1", membershipId: 5, name: "Manager", email: "manager@example.com", designation: null },
    delegation: null,
    queue: null,
    skipped: [],
    slaHours: 48,
    dueAt: "2026-09-23T00:00:00.000Z",
    escalation: null,
    explanation: "Manager approves as reporting manager.",
    ...overrides,
  };
}

async function makeServices(
  db: ReturnType<typeof makeDb>,
  employment?: { getFacts?: jest.Mock },
  approvals?: { resolve: jest.Mock },
): Promise<{ engine: HrWorkflowEngineService; approver: HrWorkflowApproverService; approvals: { resolve: jest.Mock } }> {
  const authority = approvals ?? { resolve: jest.fn().mockResolvedValue(makeRoute()) };
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      HrWorkflowApproverService,
      HrWorkflowStepRunnerService,
      HrWorkflowEngineService,
      { provide: DRIZZLE, useValue: db },
      { provide: AccessService, useValue: makeAccessService() },
      {
        provide: EmploymentFactsService,
        useValue: employment ?? { getFacts: jest.fn().mockResolvedValue(makeEmploymentFacts()) },
      },
      { provide: ApprovalAuthorityService, useValue: authority },
    ],
  }).compile();
  return {
    engine: module.get(HrWorkflowEngineService),
    approver: module.get(HrWorkflowApproverService),
    approvals: authority,
  };
}

describe("HrWorkflowApproverService — resolveApprovers", () => {
  it("returns named_user approver value directly", async () => {
    const db = makeDb([]);
    const { approver } = await makeServices(db);
    const step = { stepOrder: 1, name: "Step 1", approverType: "named_user", approverValue: "user-fixed", mode: "serial" };
    const result = await approver.resolveApprovers(step, "emp1", "org1", "leave_request");
    expect(result).toEqual(["user-fixed"]);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("returns empty array for named_user with null approverValue", async () => {
    const db = makeDb([]);
    const { approver } = await makeServices(db);
    const step = { stepOrder: 1, name: "Step 1", approverType: "named_user", approverValue: null, mode: "serial" };
    const result = await approver.resolveApprovers(step, "emp1", "org1", "leave_request");
    expect(result).toEqual([]);
  });

  it("routes a direct_manager step through the approval authority as the workflow-approve key, starting at the reporting manager", async () => {
    const db = makeDb([]);
    const { approver, approvals } = await makeServices(db);
    const step = { stepOrder: 1, name: "Step 1", approverType: "direct_manager", mode: "serial" };
    const result = await approver.resolveApprovers(step, "emp1", "org1", "leave_request");
    expect(result).toEqual(["manager-1"]);
    expect(approvals.resolve).toHaveBeenCalledWith("org1", "emp1", "leave", { permission: "hr:workflows:approve", from: "reporting_manager" });
  });

  it("starts a managers_manager step at the manager's manager rung and a department_head step at the department head", async () => {
    const db = makeDb([]);
    const { approver, approvals } = await makeServices(db);
    await approver.resolveApprovers({ stepOrder: 1, name: "Step 1", approverType: "managers_manager", mode: "serial" }, "emp1", "org1", "overtime_request");
    await approver.resolveApprovers({ stepOrder: 2, name: "Step 2", approverType: "department_head", mode: "serial" }, "emp1", "org1", "promotion");
    expect(approvals.resolve).toHaveBeenNthCalledWith(1, "org1", "emp1", "overtime", { permission: "hr:workflows:approve", from: "managers_manager" });
    expect(approvals.resolve).toHaveBeenNthCalledWith(2, "org1", "emp1", "hr_case", { permission: "hr:workflows:approve", from: "department_head" });
  });

  it("names every queue member when the chain falls through to the queue, and nobody when the request is unowned", async () => {
    const db = makeDb([]);
    const queued = makeRoute({
      rung: "queue",
      assignedTo: null,
      approver: null,
      queue: {
        permission: "hr:workflows:approve",
        label: "HR workflow approvers",
        memberCount: 2,
        members: [
          { userId: "hr-1", membershipId: 7, name: "HR One", email: "hr1@example.com", designation: null },
          { userId: "hr-2", membershipId: 8, name: "HR Two", email: "hr2@example.com", designation: null },
        ],
      },
    });
    const { approver } = await makeServices(db, undefined, {
      resolve: jest.fn().mockResolvedValueOnce(queued).mockResolvedValueOnce(makeRoute({ rung: null, assignedTo: null, approver: null })),
    });
    const step = { stepOrder: 1, name: "Step 1", approverType: "direct_manager", mode: "serial" };
    await expect(approver.resolveApprovers(step, "emp1", "org1", "leave_request")).resolves.toEqual(["hr-1", "hr-2"]);
    await expect(approver.resolveApprovers(step, "emp1", "org1", "leave_request")).resolves.toEqual([]);
  });

  it("persists the routing it resolved so acting and the inbox read the same approvers without re-resolving", async () => {
    const db = makeDb([]);
    const { approver } = await makeServices(db);
    const step = { stepOrder: 1, name: "Step 1", approverType: "direct_manager", mode: "serial" };
    const routing = await approver.resolveStepRouting(step, "emp1", "org1", "leave_request");
    expect(routing).toEqual({
      rung: "reporting_manager",
      approverUserIds: ["manager-1"],
      assignedToUserId: "manager-1",
      delegation: null,
      explanation: "Manager approves as reporting manager.",
      dueAt: "2026-09-23T00:00:00.000Z",
      escalationRung: null,
    });
  });

  it("resolves dynamic_expression dot-path on employment facts", async () => {
    const db = makeDb([[{ role: "MEMBER" }]]);
    const { approver } = await makeServices(db, {
      getFacts: jest.fn().mockResolvedValue(makeEmploymentFacts({ managerUserId: "mgr-from-dot-path" })),
    });
    const step = { stepOrder: 1, name: "Step 1", approverType: "dynamic_expression", approverValue: "user.reportingTo", mode: "serial" };
    const result = await approver.resolveApprovers(step, "emp1", "org1", "leave_request");
    expect(result).toEqual(["mgr-from-dot-path"]);
  });

  it("returns empty for dynamic_expression when dot-path value is null", async () => {
    const db = makeDb([[{ role: "MEMBER" }]]);
    const { approver } = await makeServices(db, {
      getFacts: jest.fn().mockResolvedValue(makeEmploymentFacts({ departmentId: null })),
    });
    const step = { stepOrder: 1, name: "Step 1", approverType: "dynamic_expression", approverValue: "user.departmentId", mode: "serial" };
    const result = await approver.resolveApprovers(step, "emp1", "org1", "leave_request");
    expect(result).toEqual([]);
  });
});

describe("HrWorkflowEngineService — startWorkflow auto-approve", () => {
  it("creates an approved instance when no active default definition exists", async () => {
    const db = makeDb(
      [[], [], [{ id: 99 }]],
      [{ id: 100, status: "approved" }],
    );
    const { engine } = await makeServices(db);

    const result = await engine.startWorkflow({
      orgId: "org1",
      objectType: "leave_request",
      objectId: "lr-1",
      requestedByUserId: "req1",
      subjectEmployeeId: "emp1",
    });

    expect(result).toMatchObject({ id: 100, status: "approved" });
  });
});

describe("HrWorkflowEngineService — act terminal states", () => {
  it("throws BadRequestException when acting on an already-approved instance", async () => {
    const db = makeDb([[buildInstance({ status: "approved" })]]);
    const { engine } = await makeServices(db);
    jest.spyOn(engine, "getInstanceOrThrow").mockResolvedValueOnce(buildInstance({ status: "approved" }) as never);
    await expect(engine.act({ orgId: "org1", instanceId: 1, actorUserId: "u1", action: "approved" })).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when acting on an already-rejected instance", async () => {
    const db = makeDb([]);
    const { engine } = await makeServices(db);
    jest.spyOn(engine, "getInstanceOrThrow").mockResolvedValueOnce(buildInstance({ status: "rejected" }) as never);
    await expect(engine.act({ orgId: "org1", instanceId: 1, actorUserId: "u1", action: "approved" })).rejects.toThrow(BadRequestException);
  });
});

describe("HrWorkflowEngineService — act reject sets status", () => {
  it("sets instance status to rejected when action is rejected", async () => {
    const db = makeDb([[{ membershipId: 1 }], [{ settings: {} }]]);
    const updateSetWhereMock = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) });
    const updateSetMock = jest.fn().mockReturnValue({ where: updateSetWhereMock });
    const updateMock = jest.fn().mockReturnValue({ set: updateSetMock });
    db.update = updateMock;
    const { engine, approver } = await makeServices(db);

    const steps = [{ stepOrder: 1, name: "HR Review", approverType: "named_user", approverValue: "hr-user", mode: "serial" }];
    const instance = buildInstance({ status: "in_progress", currentStepOrder: 1, definitionSnapshot: { steps } });
    const rejectedInstance = { ...instance, status: "rejected" };

    jest.spyOn(engine, "getInstanceOrThrow")
      .mockResolvedValueOnce(instance as never)
      .mockResolvedValueOnce(rejectedInstance as never);
    jest.spyOn(approver, "resolveApprovers").mockResolvedValueOnce(["hr-user"]);

    const result = await engine.act({ orgId: "org1", instanceId: 1, actorUserId: "hr-user", actorMembershipId: 1, action: "rejected" });
    expect(updateMock).toHaveBeenCalled();
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected" }));
    expect(result.status).toBe("rejected");
  });
});

describe("HrWorkflowEngineService — act non-approver denied", () => {
  it("throws ForbiddenException when actor is not in the resolved approvers list", async () => {
    const db = makeDb([[{ settings: {} }]]);
    const { engine, approver } = await makeServices(db);

    const steps = [{ stepOrder: 1, name: "Step 1", approverType: "named_user", approverValue: "hr-user", mode: "serial" }];
    const instance = buildInstance({ status: "in_progress", currentStepOrder: 1, definitionSnapshot: { steps } });

    jest.spyOn(engine, "getInstanceOrThrow").mockResolvedValueOnce(instance as never);
    jest.spyOn(approver, "resolveApprovers").mockResolvedValueOnce(["hr-user"]);

    await expect(
      engine.act({ orgId: "org1", instanceId: 1, actorUserId: "random-user", action: "approved" }),
    ).rejects.toThrow(ForbiddenException);

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("HrWorkflowEngineService — getInstanceOrThrow", () => {
  it("throws NotFoundException when instance does not exist in the org", async () => {
    const db = makeDb([[]]);
    const { engine } = await makeServices(db);
    await expect(engine.getInstanceOrThrow("org1", 999)).rejects.toThrow(NotFoundException);

    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("returns the instance when found", async () => {
    const instance = buildInstance({ id: 5 });
    const db = makeDb([[instance]]);
    const { engine } = await makeServices(db);
    const result = await engine.getInstanceOrThrow("org1", 5);
    expect(result).toMatchObject({ id: 5 });
  });
});
