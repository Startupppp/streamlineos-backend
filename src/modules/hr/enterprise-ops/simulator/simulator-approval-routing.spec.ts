import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import {
  hrWorkflowDefinitions,
  hrWorkflowSteps,
  organizationMembers,
  users,
} from "../../../../db/schema";
import { SimulatorService } from "./simulator.service";

const ORG = "org-1";
const ACTOR = "actor-1";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

const DEFINITION = { id: 7, name: "Leave — default", version: 2 };
const STEPS = [
  { id: 71, stepOrder: 1, name: "Manager", approverType: "direct_manager", approverValue: null, mode: "serial" },
  { id: 72, stepOrder: 2, name: "HR", approverType: "hr_role", approverValue: null, mode: "serial" },
];

interface Fixtures {
  members?: unknown[];
  definitions?: unknown[];
  steps?: unknown[];
  users?: unknown[];
}

function makeDb(fixtures: Fixtures) {
  const whereArgs: unknown[] = [];
  const rowsFor = (table: unknown): unknown[] => {
    if (table === organizationMembers) return fixtures.members ?? [{ userId: ALICE }];
    if (table === hrWorkflowDefinitions) return fixtures.definitions ?? [];
    if (table === hrWorkflowSteps) return fixtures.steps ?? [];
    if (table === users) return fixtures.users ?? [];
    return [];
  };
  const chain = (rows: unknown[]) => {
    const self: Record<string, unknown> = {
      where: (arg: unknown) => {
        whereArgs.push(arg);
        return self;
      },
      orderBy: () => self,
      limit: () => self,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return self;
  };
  const inserted: unknown[] = [];
  const db = {
    select: () => ({ from: (table: unknown) => chain(rowsFor(table)) }),
    insert: () => ({
      values: async (v: unknown) => {
        inserted.push(v);
        return [];
      },
    }),
  } as unknown as Db;
  return { db, inserted };
}

function approverDouble(bySubject: Record<string, string[][]>) {
  const calls: { subject: string; approverType: string }[] = [];
  return {
    calls,
    service: {
      resolveApprovers: jest.fn(async (step: { approverType: string; stepOrder: number }, subject: string) => {
        calls.push({ subject, approverType: step.approverType });
        return bySubject[subject]?.[step.stepOrder - 1] ?? [];
      }),
    },
  };
}

describe("SimulatorService.simulateApprovalRouting — simulates for the employee asked about", () => {
  it("resolves each step's approvers for the requested employee", async () => {
    const { db } = makeDb({
      definitions: [DEFINITION],
      steps: STEPS,
      users: [
        { id: "mgr-alice", name: "Alice's Manager", email: "am@example.com" },
        { id: "hr-1", name: "HR One", email: "hr1@example.com" },
      ],
    });
    const approvers = approverDouble({ [ALICE]: [["mgr-alice"], ["hr-1"]] });
    const svc = new SimulatorService(db, { evaluatePolicy: jest.fn() } as never, approvers.service as never);

    const result = await svc.simulateApprovalRouting(ORG, ACTOR, {
      objectType: "leave_request",
      hypotheticalContext: {},
      employeeId: ALICE,
    });

    expect(approvers.service.resolveApprovers).toHaveBeenCalledTimes(2);
    expect(approvers.calls.every((c) => c.subject === ALICE)).toBe(true);
    expect(result.employeeId).toBe(ALICE);
    expect(result.matchedWorkflow).toEqual({ id: 7, name: "Leave — default", version: 2 });
    expect(result.resolvedSteps).toEqual([
      expect.objectContaining({
        stepOrder: 1,
        approverType: "direct_manager",
        approvers: [{ userId: "mgr-alice", name: "Alice's Manager", email: "am@example.com" }],
      }),
      expect.objectContaining({
        stepOrder: 2,
        approverType: "hr_role",
        approvers: [{ userId: "hr-1", name: "HR One", email: "hr1@example.com" }],
      }),
    ]);
    expect(result.unresolvedSteps).toEqual([]);
  });

  it("gives a DIFFERENT answer for a different employee on the same workflow", async () => {
    const bySubject = { [ALICE]: [["mgr-alice"]], [BOB]: [["mgr-bob"]] };
    const run = async (employeeId: string) => {
      const { db } = makeDb({
        definitions: [DEFINITION],
        steps: [STEPS[0]],
        users: [
          { id: "mgr-alice", name: "Alice's Manager", email: "am@example.com" },
          { id: "mgr-bob", name: "Bob's Manager", email: "bm@example.com" },
        ],
      });
      const approvers = approverDouble(bySubject);
      const svc = new SimulatorService(db, { evaluatePolicy: jest.fn() } as never, approvers.service as never);
      return svc.simulateApprovalRouting(ORG, ACTOR, {
        objectType: "leave_request",
        hypotheticalContext: {},
        employeeId,
      });
    };

    const forAlice = await run(ALICE);
    const forBob = await run(BOB);

    expect(forAlice.resolvedSteps[0]?.approvers.map((a) => a.userId)).toEqual(["mgr-alice"]);
    expect(forBob.resolvedSteps[0]?.approvers.map((a) => a.userId)).toEqual(["mgr-bob"]);
    expect(forAlice.resolvedSteps).not.toEqual(forBob.resolvedSteps);
  });

  it("reports the steps it could not resolve an approver for instead of implying none is needed", async () => {
    const { db } = makeDb({ definitions: [DEFINITION], steps: STEPS });
    const approvers = approverDouble({ [ALICE]: [[], []] });
    const svc = new SimulatorService(db, { evaluatePolicy: jest.fn() } as never, approvers.service as never);

    const result = await svc.simulateApprovalRouting(ORG, ACTOR, {
      objectType: "leave_request",
      hypotheticalContext: {},
      employeeId: ALICE,
    });

    expect(result.unresolvedSteps).toEqual([1, 2]);
  });

  it("404s an employee who is not a member of the caller's organization", async () => {
    const { db } = makeDb({ members: [] });
    const approvers = approverDouble({});
    const svc = new SimulatorService(db, { evaluatePolicy: jest.fn() } as never, approvers.service as never);

    await expect(
      svc.simulateApprovalRouting(ORG, ACTOR, {
        objectType: "leave_request",
        hypotheticalContext: {},
        employeeId: BOB,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(approvers.service.resolveApprovers).not.toHaveBeenCalled();
  });

  it("returns no workflow for an objectType outside the workflow enum instead of failing the query", async () => {
    const { db } = makeDb({ definitions: [DEFINITION], steps: STEPS });
    const approvers = approverDouble({});
    const svc = new SimulatorService(db, { evaluatePolicy: jest.fn() } as never, approvers.service as never);

    const result = await svc.simulateApprovalRouting(ORG, ACTOR, {
      objectType: "expense",
      hypotheticalContext: {},
      employeeId: ALICE,
    });

    expect(result.matchedWorkflow).toBeNull();
    expect(result.resolvedSteps).toEqual([]);
  });
});
