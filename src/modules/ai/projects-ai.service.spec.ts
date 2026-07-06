import { Test, type TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { ProjectsAiService } from "./services/projects-ai.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { LlmService } from "./providers/llm.service";
import { AuditService } from "../../common/audit/audit.service";

function q(value: unknown[]): Promise<unknown[]> & { limit: jest.Mock } {
  const p = Promise.resolve(value);
  const limitFn = jest.fn().mockResolvedValue(value);
  return Object.assign(p, { limit: limitFn }) as unknown as Promise<unknown[]> & { limit: jest.Mock };
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

const mockLlm = {
  isConfigured: jest.fn().mockReturnValue(true),
  invokeStructured: jest.fn(),
};

const mockAudit = {
  log: jest.fn(),
};

describe("ProjectsAiService", () => {
  let service: ProjectsAiService;
  let mockWhere: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockLlm.invokeStructured.mockResolvedValue({
      summary: "Default LLM summary",
      highlights: [],
      atRisk: false,
    });

    mockWhere = jest.fn();
    const mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: mockWhere,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsAiService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: LlmService, useValue: mockLlm },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get(ProjectsAiService);
  });

  describe("summarize — empty project short-circuit", () => {
    it("returns typed empty shape and does NOT call LLM when project has no tickets", async () => {
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
      expect(mockLlm.invokeStructured).not.toHaveBeenCalled();
      expect(mockAudit.log).not.toHaveBeenCalled();
    });
  });

  describe("detectRisks — empty project short-circuit", () => {
    it("returns empty risks and evidence zeros, does NOT call LLM when project has no tickets", async () => {
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
      expect(mockLlm.invokeStructured).not.toHaveBeenCalled();
      expect(mockAudit.log).not.toHaveBeenCalled();
    });
  });

  describe("draftClientUpdate — empty project short-circuit", () => {
    it("returns NO_DATA headline and empty body/sections, does NOT call LLM when project has no tickets", async () => {
      let callCount = 0;
      mockWhere.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return q([mockProject]);
        return q([]);
      });

      const result = await service.draftClientUpdate("org_1", 1, "user_1");

      expect(result).toMatchObject({ headline: expect.any(String), body: "", sections: [] });
      expect(mockLlm.invokeStructured).not.toHaveBeenCalled();
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

      mockLlm.invokeStructured.mockResolvedValue({
        headline: "On track",
        body: "Everything is fine.",
        sections: [],
      });

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
      expect(mockLlm.invokeStructured).not.toHaveBeenCalled();
    });

    it("throws NotFoundException for detectRisks on a project outside the caller org", async () => {
      mockWhere.mockReturnValue(q([]));

      await expect(service.detectRisks("attacker_org", 1, "attacker_user")).rejects.toThrow(NotFoundException);
      expect(mockLlm.invokeStructured).not.toHaveBeenCalled();
    });

    it("throws NotFoundException for draftClientUpdate on a project outside the caller org", async () => {
      mockWhere.mockReturnValue(q([]));

      await expect(service.draftClientUpdate("attacker_org", 1, "attacker_user")).rejects.toThrow(NotFoundException);
      expect(mockLlm.invokeStructured).not.toHaveBeenCalled();
    });
  });
});
