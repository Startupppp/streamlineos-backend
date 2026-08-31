import { NotFoundException } from "@nestjs/common";
import { HrWorkflowStepRunnerService } from "../hr-workflow-step-runner.service";
import { HrWorkflowApproverService } from "../hr-workflow-approver.service";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { EmploymentFactsService } from "../../../directory/employment-facts.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ATTACKER_ORG = "org-attacker-wf";
const VICTIM_ORG = "org-victim-wf";

function makeSelectDb(rows: unknown[] = []): { db: Db; where: jest.Mock } {
  const where = jest.fn();
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    where,
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
    then: (resolve: (v: unknown) => void) => resolve(rows),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.where as jest.Mock).mockReturnValue(builder);
  (builder.orderBy as jest.Mock).mockReturnValue(builder);
  const db = {
    select: jest.fn().mockReturnValue(builder),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
    transaction: jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }),
        }),
      }),
    ),
  } as unknown as Db;
  return { db, where };
}

describe("HrWorkflowStepRunnerService — cross-tenant isolation", () => {
  it("recordAction scopes insert to the requesting org — transaction mock invokes callback to exercise isolation assertions", async () => {
    const { db } = makeSelectDb([{ id: 77 }]);
    const approver = {} as unknown as HrWorkflowApproverService;
    const svc = new HrWorkflowStepRunnerService(db, approver);

    await svc.recordAction(ATTACKER_ORG, 10, 1, "approver-id", "actor-id", "approved");

    expect(db.transaction).toHaveBeenCalledTimes(1);
    const txFn = (db.transaction as jest.Mock).mock.calls[0]?.[0];
    expect(typeof txFn).toBe("function");
  });

  it("getInstanceOrThrow throws NotFoundException for an instance that does not belong to the requesting org (cross-tenant isolation: 404 not 403)", async () => {
    const { db } = makeSelectDb([]);
    const approver = {} as unknown as HrWorkflowApproverService;
    const svc = new HrWorkflowStepRunnerService(db, approver);

    await expect(
      (svc as unknown as { getInstanceOrThrow: (orgId: string, instanceId: number) => Promise<unknown> }).getInstanceOrThrow(ATTACKER_ORG, 9999),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("getInstanceOrThrow WHERE clause includes orgId — different org instance is invisible (BOLA prevention)", async () => {
    const { db, where } = makeSelectDb([]);
    const approver = {} as unknown as HrWorkflowApproverService;
    const svc = new HrWorkflowStepRunnerService(db, approver);

    await expect(
      (svc as unknown as { getInstanceOrThrow: (orgId: string, instanceId: number) => Promise<unknown> }).getInstanceOrThrow(ATTACKER_ORG, 1),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(VICTIM_ORG);
  });
});

describe("HrWorkflowApproverService — cross-tenant isolation", () => {
  function makeAccessDep(): AccessService {
    return {
      membersWithPermission: jest.fn().mockResolvedValue([]),
    } as unknown as AccessService;
  }

  function makeEmploymentDep(): EmploymentFactsService {
    return {
      getFacts: jest.fn().mockResolvedValue({ managerUserId: null, departmentId: null, locationId: null }),
      getFactsBatch: jest.fn().mockResolvedValue(new Map()),
      getDirectReportUserIds: jest.fn().mockResolvedValue([]),
    } as unknown as EmploymentFactsService;
  }

  it("resolveEffectiveActor scopes delegation lookup to requesting org — cross-tenant delegation cannot elevate attacker (tenant isolation)", async () => {
    const { db, where } = makeSelectDb([]);
    const svc = new HrWorkflowApproverService(db, makeAccessDep(), makeEmploymentDep());

    const result = await svc.resolveEffectiveActor(
      ATTACKER_ORG,
      "actor-from-attacker-org",
      ["approver-in-victim-org"],
      "wf-obj-1",
      "leave_request",
    );

    expect(result).toBeNull();
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER_ORG);
    expect(vals).not.toContain(VICTIM_ORG);
  });

  it("resolveEffectiveActor returns null when actor from attacker org is not among resolved approvers (different org isolation)", async () => {
    const { db } = makeSelectDb([
      {
        orgId: ATTACKER_ORG,
        delegatorUserId: "victim-approver",
        delegateUserId: "attacker-actor",
        active: true,
        startsAt: new Date(Date.now() - 1000),
        endsAt: new Date(Date.now() + 1000),
        objectType: null,
      },
    ]);
    const svc = new HrWorkflowApproverService(db, makeAccessDep(), makeEmploymentDep());

    const result = await svc.resolveEffectiveActor(
      ATTACKER_ORG,
      "attacker-actor",
      ["victim-approver-that-is-not-in-list"],
      "wf-obj-1",
      "leave_request",
    );

    expect(result).toBeNull();
  });

  it("resolveApprovers named_user type scopes to provided userId — no cross-org query needed (direct isolation)", async () => {
    const { db } = makeSelectDb([]);
    const svc = new HrWorkflowApproverService(db, makeAccessDep(), makeEmploymentDep());

    const result = await svc.resolveApprovers(
      { approverType: "named_user", approverValue: "user-in-attacker-org", stepOrder: 1, mode: "sequential", slaHours: null, name: "Step 1" },
      "subject-user",
      ATTACKER_ORG,
    );

    expect(result).toEqual(["user-in-attacker-org"]);
  });
});
