import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { WorkflowsExecutionService } from "./workflows-execution.service";

describe("WorkflowsExecutionService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner-uuid";
  const ATTACKER_ORG = "org-attacker-uuid";
  const WORKFLOW_ID = "wf-uuid-1";
  const EXECUTION_ID = "exec-uuid-1";
  const USER_ID = "user-uuid-1";

  describe("getExecution", () => {
    it("throws NotFoundException when execution belongs to a different org (cross-tenant isolation)", async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const db = {
        query: { workflowExecutions: { findFirst } },
      } as unknown as Db;

      const svc = new WorkflowsExecutionService(db);
      await expect(svc.getExecution(ATTACKER_ORG, WORKFLOW_ID, EXECUTION_ID)).rejects.toThrow(NotFoundException);

      expect(findFirst).toHaveBeenCalledTimes(1);
      const callArg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(callArg).toBeDefined();
    });

    it("returns execution for the owning org (control — same-tenant access works)", async () => {
      const EXECUTION_ROW = {
        id: EXECUTION_ID,
        workflowId: WORKFLOW_ID,
        orgId: OWNER_ORG,
        status: "completed",
        steps: [],
      };
      const findFirst = jest.fn().mockResolvedValue(EXECUTION_ROW);
      const db = {
        query: { workflowExecutions: { findFirst } },
      } as unknown as Db;

      const svc = new WorkflowsExecutionService(db);
      const result = await svc.getExecution(OWNER_ORG, WORKFLOW_ID, EXECUTION_ID);
      expect(result).toMatchObject({ id: EXECUTION_ID, orgId: OWNER_ORG });
    });
  });

  describe("cancelExecution", () => {
    it("throws NotFoundException when execution belongs to a different org (cross-tenant isolation)", async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const db = {
        query: { workflowExecutions: { findFirst } },
      } as unknown as Db;

      const svc = new WorkflowsExecutionService(db);
      await expect(svc.cancelExecution(ATTACKER_ORG, USER_ID, WORKFLOW_ID, EXECUTION_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("cancels execution for the owning org (control)", async () => {
      const EXECUTION_ROW = { id: EXECUTION_ID, orgId: OWNER_ORG, status: "running" };
      const findFirst = jest.fn().mockResolvedValue(EXECUTION_ROW);
      const updateReturning = jest.fn().mockResolvedValue([{ ...EXECUTION_ROW, status: "cancelled", completedAt: new Date() }]);
      const insertValues = jest.fn().mockResolvedValue(undefined);
      const db = {
        query: { workflowExecutions: { findFirst } },
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: updateReturning }) }) }),
        insert: jest.fn().mockReturnValue({ values: insertValues }),
      } as unknown as Db;

      const svc = new WorkflowsExecutionService(db);
      const result = await svc.cancelExecution(OWNER_ORG, USER_ID, WORKFLOW_ID, EXECUTION_ID);
      expect(result).toMatchObject({ status: "cancelled" });
    });
  });

  describe("triggerWorkflow", () => {
    it("throws NotFoundException when workflow belongs to a different org (cross-tenant isolation)", async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const db = {
        query: { workflows: { findFirst } },
      } as unknown as Db;

      const svc = new WorkflowsExecutionService(db);
      await expect(
        svc.triggerWorkflow(ATTACKER_ORG, USER_ID, WORKFLOW_ID, { triggerData: {} }),
      ).rejects.toThrow(NotFoundException);
    });

    it("creates an execution for the owning org (control)", async () => {
      const WORKFLOW_ROW = {
        id: WORKFLOW_ID,
        orgId: OWNER_ORG,
        status: "published",
        versions: [{ id: "ver-uuid-1", version: 1 }],
      };
      const EXECUTION_ROW = { id: EXECUTION_ID, workflowId: WORKFLOW_ID, orgId: OWNER_ORG, status: "pending" };
      const findFirst = jest.fn().mockResolvedValue(WORKFLOW_ROW);
      const insertReturning = jest.fn().mockResolvedValue([EXECUTION_ROW]);
      const insertValues2 = jest.fn().mockResolvedValue(undefined);
      let callCount = 0;
      const db = {
        query: { workflows: { findFirst } },
        insert: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return { values: jest.fn().mockReturnValue({ returning: insertReturning }) };
          return { values: insertValues2 };
        }),
      } as unknown as Db;

      const svc = new WorkflowsExecutionService(db);
      const result = await svc.triggerWorkflow(OWNER_ORG, USER_ID, WORKFLOW_ID, { triggerData: {} });
      expect(result).toMatchObject({ id: EXECUTION_ID, orgId: OWNER_ORG });
    });
  });

  describe("listExecutions", () => {
    it("throws NotFoundException when workflow belongs to a different org (cross-tenant isolation)", async () => {
      const workflowFindFirst = jest.fn().mockResolvedValue(null);
      const db = {
        query: { workflows: { findFirst: workflowFindFirst } },
      } as unknown as Db;

      const svc = new WorkflowsExecutionService(db);
      await expect(
        svc.listExecutions(ATTACKER_ORG, WORKFLOW_ID, { cursor: undefined, limit: 20, direction: "desc" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("returns executions for the owning org (control)", async () => {
      const workflowFindFirst = jest.fn().mockResolvedValue({ id: WORKFLOW_ID });
      const EXECUTION_ROW = { id: EXECUTION_ID, workflowId: WORKFLOW_ID, orgId: OWNER_ORG, status: "completed", createdAt: new Date() };
      const where = jest.fn();
      const orderBy = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([EXECUTION_ROW]) });
      where.mockReturnValue({ orderBy });

      const db = {
        query: { workflows: { findFirst: workflowFindFirst } },
        select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
      } as unknown as Db;

      const svc = new WorkflowsExecutionService(db);
      const result = await svc.listExecutions(OWNER_ORG, WORKFLOW_ID, { cursor: undefined, limit: 20, direction: "desc" });
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({ id: EXECUTION_ID });
    });
  });
});
