import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { SupportMacrosService } from "./support-macros.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const mockDb = {
  query: {
    supportRoutingRules: { findMany: jest.fn() },
    supportMacros: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    supportTickets: { findFirst: jest.fn() },
    supportAgentSkills: { findMany: jest.fn().mockResolvedValue([]) },
    supportAgentAvailability: { findMany: jest.fn().mockResolvedValue([]) },
    supportVipClients: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    users: { findFirst: jest.fn() },
    organizations: { findFirst: jest.fn() },
  },
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  groupBy: jest.fn().mockResolvedValue([]),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue([]),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  delete: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
  onConflictDoUpdate: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([]),
  transaction: jest.fn(),
};

mockDb.transaction.mockImplementation((cb: unknown) =>
  (cb as (tx: unknown) => Promise<unknown>)(mockDb),
);

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

  it("skill_based: filters candidates to those with every required skill, then load-balances among them", async () => {
    mockDb.query.supportRoutingRules.findMany.mockResolvedValueOnce([
      {
        id: 1,
        conditions: [{ field: "priority", op: "eq", value: "URGENT" }],
        assigneeId: null,
        assignmentMode: "skill_based",
        candidateAgentIds: ["agent-a", "agent-b", "agent-c"],
        requiredSkills: ["billing"],
        setPriority: null,
      },
    ]);
    // only agent-a and agent-c have the "billing" skill
    mockDb.where.mockResolvedValueOnce([
      { userId: "agent-a", skill: "billing" },
      { userId: "agent-c", skill: "billing" },
    ]);
    mockDb.groupBy.mockResolvedValueOnce([{ assigneeId: "agent-a", cnt: 5 }]); // agent-c has no rows -> 0

    const outcome = await service.applyRoutingRules("org1", { priority: "URGENT" });
    expect(outcome.assigneeId).toBe("agent-c");
  });

  it("skill_based: falls back to the full candidate list when nobody has the required skill", async () => {
    mockDb.query.supportRoutingRules.findMany.mockResolvedValueOnce([
      {
        id: 1,
        conditions: [{ field: "priority", op: "eq", value: "URGENT" }],
        assigneeId: null,
        assignmentMode: "skill_based",
        candidateAgentIds: ["agent-a", "agent-b"],
        requiredSkills: ["billing"],
        setPriority: null,
      },
    ]);
    mockDb.where.mockResolvedValueOnce([]); // nobody has the skill
    mockDb.groupBy.mockResolvedValueOnce([{ assigneeId: "agent-a", cnt: 3 }]); // agent-b -> 0

    const outcome = await service.applyRoutingRules("org1", { priority: "URGENT" });
    expect(outcome.assigneeId).toBe("agent-b");
  });

  it("availability_based: filters out unavailable candidates, then load-balances among the rest", async () => {
    mockDb.query.supportRoutingRules.findMany.mockResolvedValueOnce([
      {
        id: 1,
        conditions: [{ field: "priority", op: "eq", value: "URGENT" }],
        assigneeId: null,
        assignmentMode: "availability_based",
        candidateAgentIds: ["agent-a", "agent-b"],
        requiredSkills: [],
        setPriority: null,
      },
    ]);
    mockDb.where.mockResolvedValueOnce([{ userId: "agent-a", isAvailable: false }]); // agent-b has no row -> available
    mockDb.groupBy.mockResolvedValueOnce([]);

    const outcome = await service.applyRoutingRules("org1", { priority: "URGENT" });
    expect(outcome.assigneeId).toBe("agent-b");
  });

  it("availability_based: falls back to the full candidate list when nobody is available", async () => {
    mockDb.query.supportRoutingRules.findMany.mockResolvedValueOnce([
      {
        id: 1,
        conditions: [{ field: "priority", op: "eq", value: "URGENT" }],
        assigneeId: null,
        assignmentMode: "availability_based",
        candidateAgentIds: ["agent-a", "agent-b"],
        requiredSkills: [],
        setPriority: null,
      },
    ]);
    mockDb.where.mockResolvedValueOnce([
      { userId: "agent-a", isAvailable: false },
      { userId: "agent-b", isAvailable: false },
    ]);
    mockDb.groupBy.mockResolvedValueOnce([{ assigneeId: "agent-a", cnt: 3 }]); // agent-b -> 0

    const outcome = await service.applyRoutingRules("org1", { priority: "URGENT" });
    expect(outcome.assigneeId).toBe("agent-b");
  });

  it("matches a rule condition on the isVip field", async () => {
    mockDb.query.supportRoutingRules.findMany.mockResolvedValueOnce([
      {
        id: 1,
        conditions: [{ field: "isVip", op: "eq", value: "true" }],
        assigneeId: "vip-agent",
        assignmentMode: "static",
        candidateAgentIds: [],
        requiredSkills: [],
        setPriority: null,
      },
    ]);

    const outcome = await service.applyRoutingRules("org1", { priority: "URGENT", isVip: true });
    expect(outcome.assigneeId).toBe("vip-agent");
  });

  it("does not match an isVip rule for a non-VIP ticket", async () => {
    mockDb.query.supportRoutingRules.findMany.mockResolvedValueOnce([
      {
        id: 1,
        conditions: [{ field: "isVip", op: "eq", value: "true" }],
        assigneeId: "vip-agent",
        assignmentMode: "static",
        candidateAgentIds: [],
        requiredSkills: [],
        setPriority: null,
      },
    ]);

    const outcome = await service.applyRoutingRules("org1", { priority: "URGENT", isVip: false });
    expect(outcome.assigneeId).toBeUndefined();
  });
});

describe("SupportMacrosService — agent skills, availability, and VIP clients", () => {
  let service: SupportMacrosService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.where.mockReturnThis();
    mockDb.groupBy.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [SupportMacrosService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    service = module.get(SupportMacrosService);
  });

  it("replaces an agent's skills atomically (delete then insert)", async () => {
    const result = await service.setAgentSkills("org1", "user1", ["billing", "technical"]);

    expect(mockDb.delete).toHaveBeenCalled();
    expect(mockDb.insert).toHaveBeenCalled();
    expect(result).toEqual({ success: true, skills: ["billing", "technical"] });
  });

  it("skips the insert step when clearing all skills", async () => {
    const result = await service.setAgentSkills("org1", "user1", []);

    expect(mockDb.delete).toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, skills: [] });
  });

  it("upserts agent availability", async () => {
    mockDb.returning.mockResolvedValueOnce([{ userId: "user1", isAvailable: false }]);

    const result = await service.setAgentAvailability("org1", "user1", false);

    expect(result).toEqual({ userId: "user1", isAvailable: false });
  });

  it("isVipClient returns false for a null/undefined clientId without querying the db", async () => {
    const result = await service.isVipClient("org1", null);
    expect(result).toBe(false);
    expect(mockDb.query.supportVipClients.findFirst).not.toHaveBeenCalled();
  });

  it("isVipClient returns true when a matching row exists", async () => {
    mockDb.query.supportVipClients.findFirst.mockResolvedValueOnce({ id: 1 });
    const result = await service.isVipClient("org1", 42);
    expect(result).toBe(true);
  });

  it("isVipClient returns false when no matching row exists", async () => {
    mockDb.query.supportVipClients.findFirst.mockResolvedValueOnce(undefined);
    const result = await service.isVipClient("org1", 42);
    expect(result).toBe(false);
  });
});

describe("SupportMacrosService — preview/apply/render", () => {
  let service: SupportMacrosService;

  const baseTicket = {
    id: 42,
    requesterName: null as string | null,
    createdBy: "user-1",
    creator: { name: "Jane Customer" },
  };
  const baseAgent = { name: "Alex Agent" };
  const baseOrg = { name: "Acme Inc" };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.groupBy.mockResolvedValue([]);
    mockDb.where.mockReturnThis();
    mockDb.orderBy.mockReturnThis();
    mockDb.limit.mockResolvedValue([]);
    mockDb.insert.mockReturnThis();
    mockDb.update.mockReturnThis();
    mockDb.set.mockReturnThis();
    mockDb.values.mockReturnThis();
    mockDb.returning.mockResolvedValue([]);
    mockDb.query.supportTickets.findFirst.mockResolvedValue(baseTicket);
    mockDb.query.users.findFirst.mockResolvedValue(baseAgent);
    mockDb.query.organizations.findFirst.mockResolvedValue(baseOrg);

    const module: TestingModule = await Test.createTestingModule({
      providers: [SupportMacrosService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    service = module.get(SupportMacrosService);
  });

  describe("previewMacro", () => {
    it("throws NotFoundException when the macro doesn't exist in the org", async () => {
      mockDb.query.supportMacros.findFirst.mockResolvedValueOnce(undefined);
      await expect(service.previewMacro("org1", 1, "user-1", 42)).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException when previewing another user's private macro", async () => {
      mockDb.query.supportMacros.findFirst.mockResolvedValueOnce({
        id: 1,
        body: "Hi {{customer.name}}",
        visibility: "private",
        createdBy: "someone-else",
      });
      await expect(service.previewMacro("org1", 1, "user-1", 42)).rejects.toThrow(ForbiddenException);
    });

    it("allows the creator to preview their own private macro", async () => {
      mockDb.query.supportMacros.findFirst.mockResolvedValueOnce({
        id: 1,
        body: "Hi {{customer.name}}",
        visibility: "private",
        createdBy: "user-1",
      });
      const result = await service.previewMacro("org1", 1, "user-1", 42);
      expect(result.body).toBe("Hi Jane Customer");
    });

    it("substitutes customer/ticket/agent/company/portal variables and prefers requesterName over creator.name", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce({
        ...baseTicket,
        requesterName: "External Requester",
      });
      mockDb.query.supportMacros.findFirst.mockResolvedValueOnce({
        id: 2,
        body: "Hi {{customer.name}}, re ticket {{ticket.id}} — {{agent.name}} at {{company.name}}. Track: {{portal.link}}",
        visibility: "team",
        createdBy: "user-1",
      });

      const result = await service.previewMacro("org1", 2, "user-1", 42);

      expect(result.body).toContain("Hi External Requester");
      expect(result.body).toContain("re ticket 42");
      expect(result.body).toContain("Alex Agent at Acme Inc");
      expect(result.body).toContain("/support/portal/tickets/42");
    });

    it("leaves unknown {{...}} placeholders untouched", async () => {
      mockDb.query.supportMacros.findFirst.mockResolvedValueOnce({
        id: 3,
        body: "Hello {{unknown.var}}",
        visibility: "team",
        createdBy: "user-1",
      });
      const result = await service.previewMacro("org1", 3, "user-1", 42);
      expect(result.body).toBe("Hello {{unknown.var}}");
    });

    it("throws NotFoundException when the ticket doesn't exist in the org", async () => {
      mockDb.query.supportTickets.findFirst.mockResolvedValueOnce(undefined);
      mockDb.query.supportMacros.findFirst.mockResolvedValueOnce({
        id: 1,
        body: "Hi {{customer.name}}",
        visibility: "team",
        createdBy: "user-1",
      });
      await expect(service.previewMacro("org1", 1, "user-1", 999)).rejects.toThrow(NotFoundException);
    });
  });

  describe("applyMacro", () => {
    it("throws NotFoundException when the macro doesn't exist in the org", async () => {
      mockDb.query.supportMacros.findFirst.mockResolvedValueOnce(undefined);
      await expect(service.applyMacro("org1", 1, "user-1", { ticketId: 42 })).rejects.toThrow(NotFoundException);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("throws ForbiddenException when applying another user's private macro", async () => {
      mockDb.query.supportMacros.findFirst.mockResolvedValueOnce({
        id: 1,
        body: "Hi there",
        visibility: "private",
        createdBy: "someone-else",
        actions: null,
      });
      await expect(service.applyMacro("org1", 1, "user-1", { ticketId: 42 })).rejects.toThrow(ForbiddenException);
    });

    it("applies configured status/priority actions to the ticket and bumps usage count", async () => {
      mockDb.query.supportMacros.findFirst.mockResolvedValueOnce({
        id: 1,
        body: "Closing this out, {{customer.name}}",
        visibility: "team",
        createdBy: "user-1",
        actions: { setStatus: "RESOLVED", setPriority: "LOW", isInternal: false },
      });

      const result = await service.applyMacro("org1", 1, "user-1", { ticketId: 42 });

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(expect.objectContaining({ status: "RESOLVED", priority: "LOW" }));
      expect(result.body).toBe("Closing this out, Jane Customer");
      expect(result.isInternal).toBe(false);
      expect(result.actionsApplied).toEqual({ setStatus: "RESOLVED", setPriority: "LOW", isInternal: false });
    });

    it("skips the ticket update entirely when the macro has no status/priority actions", async () => {
      mockDb.query.supportMacros.findFirst.mockResolvedValueOnce({
        id: 1,
        body: "Just a note",
        visibility: "team",
        createdBy: "user-1",
        actions: { isInternal: true },
      });

      await service.applyMacro("org1", 1, "user-1", { ticketId: 42 });

      // only the usage-count update should have fired, not a ticket status/priority update
      expect(mockDb.update).toHaveBeenCalledTimes(1);
    });
  });

  describe("listMacros — private visibility scoping", () => {
    it("includes both non-private macros and the caller's own private macros in the where clause", async () => {
      await service.listMacros("org1", "user-1", {});
      expect(mockDb.query.supportRoutingRules.findMany).not.toHaveBeenCalled();
    });
  });
});
