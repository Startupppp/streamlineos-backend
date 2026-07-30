import { Test, type TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { HrWorkflowEngineService } from "../hr-workflow-engine.service";
import { AccessService } from "../../access/access.service";

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

async function makeService(db: ReturnType<typeof makeDb>): Promise<HrWorkflowEngineService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      HrWorkflowEngineService,
      { provide: DRIZZLE, useValue: db },
      { provide: AccessService, useValue: makeAccessService() },
    ],
  }).compile();
  return module.get(HrWorkflowEngineService);
}

describe("HrWorkflowEngineService — resolveApprovers", () => {
  it("returns named_user approver value directly", async () => {
    const db = makeDb([]);
    const service = await makeService(db);
    const step = { stepOrder: 1, name: "Step 1", approverType: "named_user", approverValue: "user-fixed", mode: "serial" };
    const result = await service.resolveApprovers(step, "emp1", "org1");
    expect(result).toEqual(["user-fixed"]);
  });

  it("returns empty array for named_user with null approverValue", async () => {
    const db = makeDb([]);
    const service = await makeService(db);
    const step = { stepOrder: 1, name: "Step 1", approverType: "named_user", approverValue: null, mode: "serial" };
    const result = await service.resolveApprovers(step, "emp1", "org1");
    expect(result).toEqual([]);
  });

  it("returns direct manager via users.reportingTo", async () => {
    const db = makeDb([[{ reportingTo: "manager-1" }]]);
    const service = await makeService(db);
    const step = { stepOrder: 1, name: "Step 1", approverType: "direct_manager", mode: "serial" };
    const result = await service.resolveApprovers(step, "emp1", "org1");
    expect(result).toEqual(["manager-1"]);
  });

  it("returns empty array when employee has no reportingTo", async () => {
    const db = makeDb([[{ reportingTo: null }]]);
    const service = await makeService(db);
    const step = { stepOrder: 1, name: "Step 1", approverType: "direct_manager", mode: "serial" };
    const result = await service.resolveApprovers(step, "emp1", "org1");
    expect(result).toEqual([]);
  });

  it("returns manager's manager via two user lookups", async () => {
    const db = makeDb([[{ reportingTo: "manager-1" }], [{ reportingTo: "grand-manager" }]]);
    const service = await makeService(db);
    const step = { stepOrder: 1, name: "Step 1", approverType: "managers_manager", mode: "serial" };
    const result = await service.resolveApprovers(step, "emp1", "org1");
    expect(result).toEqual(["grand-manager"]);
  });

  it("returns empty for managers_manager when direct manager has no reportingTo", async () => {
    const db = makeDb([[{ reportingTo: "manager-1" }], [{ reportingTo: null }]]);
    const service = await makeService(db);
    const step = { stepOrder: 1, name: "Step 1", approverType: "managers_manager", mode: "serial" };
    const result = await service.resolveApprovers(step, "emp1", "org1");
    expect(result).toEqual([]);
  });

  it("resolves dynamic_expression dot-path on user object", async () => {
    const db = makeDb([[{ id: "emp1", reportingTo: "mgr-from-dot-path", firstName: "Alice" }]]);
    const service = await makeService(db);
    const step = { stepOrder: 1, name: "Step 1", approverType: "dynamic_expression", approverValue: "user.reportingTo", mode: "serial" };
    const result = await service.resolveApprovers(step, "emp1", "org1");
    expect(result).toEqual(["mgr-from-dot-path"]);
  });

  it("returns empty for dynamic_expression when dot-path value resolves to a number not string", async () => {
    const db = makeDb([[{ id: "emp1", departmentId: 5 }]]);
    const service = await makeService(db);
    const step = { stepOrder: 1, name: "Step 1", approverType: "dynamic_expression", approverValue: "user.departmentId", mode: "serial" };
    const result = await service.resolveApprovers(step, "emp1", "org1");
    expect(result).toEqual([]);
  });
});

describe("HrWorkflowEngineService — startWorkflow auto-approve", () => {
  it("creates an approved instance when no active default definition exists", async () => {
    const db = makeDb(
      [[], [], [{ id: 99 }]],
      [{ id: 100, status: "approved" }],
    );
    const service = await makeService(db);

    const result = await service.startWorkflow({
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
    const service = await makeService(db);
    jest.spyOn(service, "getInstanceOrThrow").mockResolvedValueOnce(buildInstance({ status: "approved" }) as never);
    await expect(service.act({ orgId: "org1", instanceId: 1, actorUserId: "u1", action: "approved" })).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when acting on an already-rejected instance", async () => {
    const db = makeDb([]);
    const service = await makeService(db);
    jest.spyOn(service, "getInstanceOrThrow").mockResolvedValueOnce(buildInstance({ status: "rejected" }) as never);
    await expect(service.act({ orgId: "org1", instanceId: 1, actorUserId: "u1", action: "approved" })).rejects.toThrow(BadRequestException);
  });
});

describe("HrWorkflowEngineService — act reject sets status", () => {
  it("sets instance status to rejected when action is rejected", async () => {
    const db = makeDb([[{ settings: {} }]]);
    const updateSetWhereMock = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) });
    const updateSetMock = jest.fn().mockReturnValue({ where: updateSetWhereMock });
    const updateMock = jest.fn().mockReturnValue({ set: updateSetMock });
    db.update = updateMock;
    const service = await makeService(db);

    const steps = [{ stepOrder: 1, name: "HR Review", approverType: "named_user", approverValue: "hr-user", mode: "serial" }];
    const instance = buildInstance({ status: "in_progress", currentStepOrder: 1, definitionSnapshot: { steps } });
    const rejectedInstance = { ...instance, status: "rejected" };

    jest.spyOn(service, "getInstanceOrThrow")
      .mockResolvedValueOnce(instance as never)
      .mockResolvedValueOnce(rejectedInstance as never);
    jest.spyOn(service, "resolveApprovers").mockResolvedValueOnce(["hr-user"]);

    const result = await service.act({ orgId: "org1", instanceId: 1, actorUserId: "hr-user", action: "rejected" });
    expect(updateMock).toHaveBeenCalled();
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected" }));
    expect(result.status).toBe("rejected");
  });
});

describe("HrWorkflowEngineService — act non-approver denied", () => {
  it("throws ForbiddenException when actor is not in the resolved approvers list", async () => {
    const db = makeDb([[{ settings: {} }]]);
    const service = await makeService(db);

    const steps = [{ stepOrder: 1, name: "Step 1", approverType: "named_user", approverValue: "hr-user", mode: "serial" }];
    const instance = buildInstance({ status: "in_progress", currentStepOrder: 1, definitionSnapshot: { steps } });

    jest.spyOn(service, "getInstanceOrThrow").mockResolvedValueOnce(instance as never);
    jest.spyOn(service, "resolveApprovers").mockResolvedValueOnce(["hr-user"]);

    await expect(
      service.act({ orgId: "org1", instanceId: 1, actorUserId: "random-user", action: "approved" }),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe("HrWorkflowEngineService — getInstanceOrThrow", () => {
  it("throws NotFoundException when instance does not exist in the org", async () => {
    const db = makeDb([[]]);
    const service = await makeService(db);
    await expect(service.getInstanceOrThrow("org1", 999)).rejects.toThrow(NotFoundException);
  });

  it("returns the instance when found", async () => {
    const instance = buildInstance({ id: 5 });
    const db = makeDb([[instance]]);
    const service = await makeService(db);
    const result = await service.getInstanceOrThrow("org1", 5);
    expect(result).toMatchObject({ id: 5 });
  });
});
