import { Test, type TestingModule } from "@nestjs/testing";
import { SupportMacrosService } from "./support-macros.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const mockDb = {
  query: {
    supportRoutingRules: { findMany: jest.fn() },
  },
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  groupBy: jest.fn().mockResolvedValue([]),
};

describe("SupportMacrosService — applyRoutingRules assignment modes", () => {
  let service: SupportMacrosService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.groupBy.mockResolvedValue([]);
    mockDb.where.mockReturnThis();

    const module: TestingModule = await Test.createTestingModule({
      providers: [SupportMacrosService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    service = module.get(SupportMacrosService);
  });

  it("assigns via the rule's static assigneeId when assignmentMode is 'static'", async () => {
    mockDb.query.supportRoutingRules.findMany.mockResolvedValueOnce([
      {
        id: 1,
        conditions: [{ field: "priority", op: "eq", value: "URGENT" }],
        assigneeId: "agent-static",
        assignmentMode: "static",
        candidateAgentIds: [],
        setPriority: null,
      },
    ]);

    const outcome = await service.applyRoutingRules("org1", { priority: "URGENT" });
    expect(outcome.assigneeId).toBe("agent-static");
  });

  it("round-robins across candidates using total ticket count as a rotating cursor", async () => {
    mockDb.query.supportRoutingRules.findMany.mockResolvedValueOnce([
      {
        id: 1,
        conditions: [{ field: "priority", op: "eq", value: "URGENT" }],
        assigneeId: null,
        assignmentMode: "round_robin",
        candidateAgentIds: ["agent-a", "agent-b", "agent-c"],
        setPriority: null,
      },
    ]);
    // total ticket count = 4 -> 4 % 3 = 1 -> candidates[1]
    mockDb.where.mockResolvedValueOnce([{ cnt: 4 }]);

    const outcome = await service.applyRoutingRules("org1", { priority: "URGENT" });
    expect(outcome.assigneeId).toBe("agent-b");
  });

  it("load-balances by picking the candidate with the fewest open/in-progress tickets", async () => {
    mockDb.query.supportRoutingRules.findMany.mockResolvedValueOnce([
      {
        id: 1,
        conditions: [{ field: "priority", op: "eq", value: "URGENT" }],
        assigneeId: null,
        assignmentMode: "load_balanced",
        candidateAgentIds: ["agent-a", "agent-b"],
        setPriority: null,
      },
    ]);
    mockDb.groupBy.mockResolvedValueOnce([
      { assigneeId: "agent-a", cnt: 5 },
      { assigneeId: "agent-b", cnt: 2 },
    ]);

    const outcome = await service.applyRoutingRules("org1", { priority: "URGENT" });
    expect(outcome.assigneeId).toBe("agent-b");
  });

  it("picks a candidate with zero workload over one with any recorded workload", async () => {
    mockDb.query.supportRoutingRules.findMany.mockResolvedValueOnce([
      {
        id: 1,
        conditions: [{ field: "priority", op: "eq", value: "URGENT" }],
        assigneeId: null,
        assignmentMode: "load_balanced",
        candidateAgentIds: ["agent-a", "agent-b"],
        setPriority: null,
      },
    ]);
    mockDb.groupBy.mockResolvedValueOnce([{ assigneeId: "agent-a", cnt: 3 }]); // agent-b has no rows -> 0

    const outcome = await service.applyRoutingRules("org1", { priority: "URGENT" });
    expect(outcome.assigneeId).toBe("agent-b");
  });
});
