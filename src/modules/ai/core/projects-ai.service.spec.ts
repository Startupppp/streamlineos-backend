import { Test, type TestingModule } from "@nestjs/testing";
import { HttpException, HttpStatus, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ProjectsAiService } from "./services/projects-ai.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AiGatewayService } from "./gateway/ai-gateway.service";
import { AuditService } from "../../../common/audit/audit.service";
import type { AiInvokeResult } from "./gateway/ai-gateway.types";

function q(value: unknown[]): Promise<unknown[]> & { limit: jest.Mock; groupBy: jest.Mock } {
  const p = Promise.resolve(value);
  const limitFn = jest.fn().mockResolvedValue(value);
  const self = Object.assign(p, { limit: limitFn }) as unknown as Promise<unknown[]> & { limit: jest.Mock; groupBy: jest.Mock };
  const groupByFn = jest.fn().mockReturnValue(self);
  self.groupBy = groupByFn;
  return self;
}

function sqlHasColumn(expr: unknown, colName: string): boolean {
  if (!expr || typeof expr !== "object") return false;
  const obj = expr as Record<string, unknown>;
  if (typeof obj.name === "string" && obj.name === colName) return true;
  if (Array.isArray(obj.queryChunks)) {
    return (obj.queryChunks as unknown[]).some((c) => sqlHasColumn(c, colName));
  }
  return false;
}

const mockProject = {
  id: 1,
  name: "Test Project",
  status: "ACTIVE",
  description: null as string | null,
  endDate: null as Date | null,
};

const mockTicketRow = { status: "DONE", dueDate: null as string | null, sprintId: null as number | null };

function makeGatewayOk<T>(data: T): AiInvokeResult<T> {
  return { ok: true, data, model: "gpt-4o-mini", latencyMs: 100, correlationId: "test-corr", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
}

function makeGatewayFail(kind: "quota_exceeded" | "not_configured" | "provider_unavailable" | "invalid_output"): AiInvokeResult<never> {
  return { ok: false, kind, message: `Simulated ${kind}`, correlationId: "test-corr" };
}

const mockGateway = {
  invokeStructured: jest.fn(),
  invokeText: jest.fn(),
};

const mockAudit = {
  log: jest.fn(),
};

describe("ProjectsAiService", () => {
  let service: ProjectsAiService;
  let mockWhere: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockGateway.invokeStructured.mockResolvedValue(
      makeGatewayOk({ summary: "Default summary", highlights: [], atRisk: false }),
    );

    mockWhere = jest.fn();
    const mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      where: mockWhere,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsAiService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AiGatewayService, useValue: mockGateway },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get(ProjectsAiService);
  });

  describe("summarize — empty project short-circuit", () => {
    it("returns typed empty shape and does NOT call gateway when project has no tickets", async () => {
      let callCount = 0;
      mockWhere.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return q([mockProject]);
        return q([]);
      });

      const result = await service.summarize("org_1", 1, "user_1");

      expect(result).toEqual({
        summary: expect.any(String),
        highlights: [],
        atRisk: false,
        evidence: { totalTasks: 0, done: 0, inProgress: 0, blocked: 0, overdue: 0 },
      });
      expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
      expect(mockAudit.log).not.toHaveBeenCalled();
    });
  });

  describe("detectRisks — empty project short-circuit", () => {
    it("returns empty risks and evidence zeros, does NOT call gateway when project has no tickets", async () => {
      let callCount = 0;
      mockWhere.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return q([mockProject]);
        return q([]);
      });

      const result = await service.detectRisks("org_1", 1, "user_1");

      expect(result).toEqual({
        risks: [],
        evidence: { totalTasks: 0, done: 0, inProgress: 0, blocked: 0, overdue: 0 },
      });
      expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
      expect(mockAudit.log).not.toHaveBeenCalled();
    });
  });

  describe("draftClientUpdate — empty project short-circuit", () => {
    it("returns NO_DATA headline and empty body/sections, does NOT call gateway when project has no tickets", async () => {
      let callCount = 0;
      mockWhere.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return q([mockProject]);
        return q([]);
      });

      const result = await service.draftClientUpdate("org_1", 1, "user_1");

      expect(result).toMatchObject({ headline: expect.any(String), body: "", sections: [] });
      expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
      expect(mockAudit.log).not.toHaveBeenCalled();
    });
  });

  describe("draftClientUpdate — clientVisible filter", () => {
    it("issues the visibleTickets query with client_visible=true and NOT the plain ticket list", async () => {
      const capturedArgs: unknown[] = [];
      let callCount = 0;

      mockWhere.mockImplementation((arg: unknown) => {
        capturedArgs.push(arg);
        callCount++;
        if (callCount === 1) return q([mockProject]);
        if (callCount === 2) return q([mockTicketRow]);
        return q([]);
      });

      mockGateway.invokeStructured.mockResolvedValue(
        makeGatewayOk({ headline: "On track", body: "Everything is fine.", sections: [] }),
      );

      await service.draftClientUpdate("org_1", 1, "user_1");

      expect(capturedArgs.length).toBeGreaterThanOrEqual(3);

      const visibleTicketsCondition = capturedArgs[2];
      expect(sqlHasColumn(visibleTicketsCondition, "client_visible")).toBe(true);

      const fetchTicketsCondition = capturedArgs[1];
      expect(sqlHasColumn(fetchTicketsCondition, "client_visible")).toBe(false);
    });
  });

  describe("assertProject — BOLA", () => {
    it("throws NotFoundException when the project does not exist in the caller org", async () => {
      mockWhere.mockReturnValue(q([]));

      await expect(service.summarize("other_org", 999, "user_1")).rejects.toThrow(NotFoundException);
      expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
    });

    it("throws NotFoundException for detectRisks on a project outside the caller org", async () => {
      mockWhere.mockReturnValue(q([]));

      await expect(service.detectRisks("attacker_org", 1, "attacker_user")).rejects.toThrow(NotFoundException);
      expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
    });

    it("throws NotFoundException for draftClientUpdate on a project outside the caller org", async () => {
      mockWhere.mockReturnValue(q([]));

      await expect(service.draftClientUpdate("attacker_org", 1, "attacker_user")).rejects.toThrow(NotFoundException);
      expect(mockGateway.invokeStructured).not.toHaveBeenCalled();
    });
  });

  describe("ask — per-member evidence", () => {
    it("includes per-member ticket counts in the evidence string passed to the gateway", async () => {
      const assigneeRows = [
        { assigneeId: "user_a", assigneeName: "Aditya Challa", total: 14, done: 9, inProgress: 3, overdue: 0 },
        { assigneeId: "user_b", assigneeName: "Jane D", total: 6, done: 6, inProgress: 0, overdue: 0 },
        { assigneeId: null, assigneeName: null, total: 3, done: 0, inProgress: 0, overdue: 0 },
      ];

      let callCount = 0;
      mockWhere.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return q([mockProject]);
        if (callCount === 2) return q([{ status: "DONE", dueDate: null, sprintId: null }]);
        return q(assigneeRows);
      });

      mockGateway.invokeStructured.mockResolvedValue(
        makeGatewayOk({ answer: "Aditya worked on 14 tickets.", confidence: "high" }),
      );

      await service.ask("org_1", 1, "How many tickets did Aditya work on?", "user_1");

      expect(mockGateway.invokeStructured).toHaveBeenCalledTimes(1);
      const callArg = mockGateway.invokeStructured.mock.calls[0][0] as { prompt: { user: string } };
      expect(callArg.prompt.user).toContain("Aditya Challa — 14 total (9 done, 3 in progress)");
      expect(callArg.prompt.user).toContain("Jane D — 6 total (6 done, 0 in progress)");
      expect(callArg.prompt.user).toContain("Unassigned — 3 total");
    });
  });

  describe("gateway failure — quota_exceeded", () => {
    it("throws 402 Payment Required when gateway returns quota_exceeded", async () => {
      let callCount = 0;
      mockWhere.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return q([mockProject]);
        return q([mockTicketRow]);
      });

      mockGateway.invokeStructured.mockResolvedValue(makeGatewayFail("quota_exceeded"));

      try {
        await service.summarize("org_1", 1, "user_1");
        throw new Error("expected quota failure");
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
      }
    });
  });

  describe("gateway failure — provider_unavailable", () => {
    it("throws ServiceUnavailableException when gateway returns provider_unavailable", async () => {
      let callCount = 0;
      mockWhere.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return q([mockProject]);
        return q([mockTicketRow]);
      });

      mockGateway.invokeStructured.mockResolvedValue(makeGatewayFail("provider_unavailable"));

      await expect(service.detectRisks("org_1", 1, "user_1")).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe("gateway failure — not_configured", () => {
    it("throws ServiceUnavailableException when gateway returns not_configured", async () => {
      let callCount = 0;
      mockWhere.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return q([mockProject]);
        return q([mockTicketRow]);
      });

      mockGateway.invokeStructured.mockResolvedValue(makeGatewayFail("not_configured"));

      await expect(service.summarize("org_1", 1, "user_1")).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe("gateway failure — invalid_output", () => {
    it("throws ServiceUnavailableException when gateway returns invalid_output", async () => {
      let callCount = 0;
      mockWhere.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return q([mockProject]);
        return q([mockTicketRow]);
      });

      mockGateway.invokeStructured.mockResolvedValue(makeGatewayFail("invalid_output"));

      await expect(service.summarize("org_1", 1, "user_1")).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe("gateway — feature keys and charge", () => {
    it("invokes gateway with correct feature key for summarize", async () => {
      let callCount = 0;
      mockWhere.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return q([mockProject]);
        return q([mockTicketRow]);
      });

      mockGateway.invokeStructured.mockResolvedValue(
        makeGatewayOk({ summary: "ok", highlights: [], atRisk: false }),
      );

      await service.summarize("org_1", 1, "user_1");

      expect(mockGateway.invokeStructured).toHaveBeenCalledWith(
        expect.objectContaining({ feature: "pm.summary", charge: true, dedupe: true }),
      );
    });

    it("invokes gateway with correct feature key for detectRisks", async () => {
      let callCount = 0;
      mockWhere.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return q([mockProject]);
        if (callCount === 2) return q([mockTicketRow]);
        return q([{ count: 0 }]);
      });

      mockGateway.invokeStructured.mockResolvedValue(
        makeGatewayOk({ risks: [] }),
      );

      await service.detectRisks("org_1", 1, "user_1");

      const call = mockGateway.invokeStructured.mock.calls[0][0] as { feature: string };
      expect(call.feature).toBe("pm.risks");
    });
  });
});
