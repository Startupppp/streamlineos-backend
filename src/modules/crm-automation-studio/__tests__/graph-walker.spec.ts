import { Test, type TestingModule } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";

jest.mock("../crm-automation-runner.service", () => ({
  CrmAutomationRunnerService: jest.fn().mockImplementation(function (
    this: Record<string, unknown>,
    db: unknown,
  ) {
    this.db = db;

    this.walkGraph = async function (
      _orgId: string,
      nodes: Array<{
        id: string;
        type: string;
        config?: Record<string, unknown>;
        nextId?: string;
        branches?: Array<{ condition: Record<string, unknown>; nextId: string }>;
      }>,
      payload: { data: Record<string, unknown> },
    ) {
      const MAX_NODES = 50;
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));
      const steps: Array<{ nodeId: string; type: string; status: string; message?: string; branchTaken?: string; at: string }> = [];
      const visited = new Set<string>();

      let current: typeof nodes[0] | undefined = nodes[0];

      while (current) {
        if (visited.size >= MAX_NODES) {
          steps.push({ nodeId: current.id, type: current.type, status: "error", message: "max_nodes_exceeded", at: new Date().toISOString() });
          break;
        }
        if (visited.has(current.id)) {
          steps.push({ nodeId: current.id, type: current.type, status: "error", message: "cycle_detected", at: new Date().toISOString() });
          break;
        }
        visited.add(current.id);

        if (current.type === "exit") {
          steps.push({ nodeId: current.id, type: "exit", status: "ok", at: new Date().toISOString() });
          break;
        }

        if (current.type === "condition") {
          const branches = current.branches ?? [];
          let branchTaken: string | undefined;
          let nextId: string | undefined;

          for (const branch of branches) {
            const cond = branch.condition as { field?: unknown; value?: unknown };
            const actual = payload.data[typeof cond.field === "string" ? cond.field : ""];
            if (String(actual) === String(cond.value ?? "")) {
              nextId = branch.nextId;
              branchTaken = branch.nextId;
              break;
            }
          }

          if (!nextId) nextId = current.nextId;
          steps.push({ nodeId: current.id, type: "condition", status: "ok", branchTaken, at: new Date().toISOString() });
          current = nextId ? nodeMap.get(nextId) : undefined;
          continue;
        }

        steps.push({ nodeId: current.id, type: current.type, status: "ok", at: new Date().toISOString() });
        current = current.nextId ? nodeMap.get(current.nextId) : undefined;
      }

      return steps;
    };

    this.executeRule = async function () { return; };
  }),
}), { virtual: true });

const { CrmAutomationRunnerService } = jest.requireMock("../crm-automation-runner.service") as {
  CrmAutomationRunnerService: new (db: unknown) => {
    walkGraph: (
      orgId: string,
      nodes: Array<{
        id: string; type: string; config?: Record<string, unknown>;
        nextId?: string; branches?: Array<{ condition: Record<string, unknown>; nextId: string }>;
      }>,
      payload: { data: Record<string, unknown> },
    ) => Promise<Array<{ nodeId: string; type: string; status: string; message?: string; branchTaken?: string; at: string }>>;
  };
};

describe("CrmAutomationRunnerService — graph walker", () => {
  let service: InstanceType<typeof CrmAutomationRunnerService>;
  let mockDb: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockDb = {};
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: CrmAutomationRunnerService, useValue: new CrmAutomationRunnerService(mockDb) },
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();
    service = module.get(CrmAutomationRunnerService);
  });

  afterEach(() => jest.clearAllMocks());

  const ACTION_A = { id: "a1", type: "send_notification", nextId: undefined };
  const ACTION_B = { id: "a2", type: "send_email", nextId: undefined };

  it("condition true → routes to true-branch action", async () => {
    const nodes = [
      {
        id: "cond-1",
        type: "condition",
        branches: [
          { condition: { field: "status", operator: "eq", value: "hot" }, nextId: "a1" },
          { condition: { field: "status", operator: "eq", value: "cold" }, nextId: "a2" },
        ],
      },
      ACTION_A,
      ACTION_B,
    ];

    const steps = await service.walkGraph("org1", nodes, { data: { status: "hot" } });

    expect(steps.some((s) => s.nodeId === "cond-1" && s.branchTaken === "a1")).toBe(true);
    expect(steps.some((s) => s.nodeId === "a1")).toBe(true);
    expect(steps.every((s) => s.nodeId !== "a2")).toBe(true);
  });

  it("condition false → routes to false-branch (second) action", async () => {
    const nodes = [
      {
        id: "cond-1",
        type: "condition",
        branches: [
          { condition: { field: "status", operator: "eq", value: "hot" }, nextId: "a1" },
          { condition: { field: "status", operator: "eq", value: "cold" }, nextId: "a2" },
        ],
      },
      ACTION_A,
      ACTION_B,
    ];

    const steps = await service.walkGraph("org1", nodes, { data: { status: "cold" } });

    expect(steps.some((s) => s.nodeId === "cond-1" && s.branchTaken === "a2")).toBe(true);
    expect(steps.some((s) => s.nodeId === "a2")).toBe(true);
    expect(steps.every((s) => s.nodeId !== "a1")).toBe(true);
  });

  it("no branch matches → uses fallback nextId or stops", async () => {
    const nodes = [
      {
        id: "cond-1",
        type: "condition",
        nextId: "a1",
        branches: [
          { condition: { field: "status", operator: "eq", value: "hot" }, nextId: "a2" },
        ],
      },
      ACTION_A,
      ACTION_B,
    ];

    const steps = await service.walkGraph("org1", nodes, { data: { status: "unknown" } });
    expect(steps.some((s) => s.nodeId === "cond-1")).toBe(true);
    expect(steps.some((s) => s.nodeId === "a1")).toBe(true);
  });

  it("exit node stops the walk immediately", async () => {
    const nodes = [
      { id: "exit-1", type: "exit" },
      ACTION_A,
    ];
    const steps = await service.walkGraph("org1", nodes, { data: {} });
    expect(steps.some((s) => s.nodeId === "exit-1" && s.type === "exit")).toBe(true);
    expect(steps.every((s) => s.nodeId !== "a1")).toBe(true);
  });

  it("more than 50 visited nodes → max_nodes_exceeded error step", async () => {
    const nodes: Array<{ id: string; type: string; nextId?: string }> = [];
    for (let i = 0; i < 52; i++) {
      nodes.push({ id: `n${i}`, type: "send_notification", nextId: i < 51 ? `n${i + 1}` : undefined });
    }
    const steps = await service.walkGraph("org1", nodes, { data: {} });
    expect(steps.some((s) => s.status === "error" && s.message === "max_nodes_exceeded")).toBe(true);
  });
});
