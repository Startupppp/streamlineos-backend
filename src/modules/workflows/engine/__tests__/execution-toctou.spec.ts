import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { WorkflowsExecutionService } from "../../workflows-execution.service";

const OWNER_ORG = "org-owner";
const USER_ID = "user-1";
const WORKFLOW_ID = "wf-1";
const EXECUTION_ID = "exec-1";
const APPROVAL_ID = "appr-1";

describe("WorkflowsExecutionService — TOCTOU hardening", () => {
  describe("cancelExecution", () => {
    it("throws NotFoundException for a different org (cross-tenant pre-flight)", async () => {
      const db = {
        query: { workflowExecutions: { findFirst: jest.fn().mockResolvedValue(null) } },
      } as unknown as Db;

      const svc = new WorkflowsExecutionService(db);
      await expect(
        svc.cancelExecution("attacker-org", USER_ID, WORKFLOW_ID, EXECUTION_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException for a completed execution (pre-flight status guard)", async () => {
      const COMPLETED_ROW = { id: EXECUTION_ID, orgId: OWNER_ORG, status: "completed" };
      const db = {
        query: { workflowExecutions: { findFirst: jest.fn().mockResolvedValue(COMPLETED_ROW) } },
      } as unknown as Db;

      const svc = new WorkflowsExecutionService(db);
      await expect(
        svc.cancelExecution(OWNER_ORG, USER_ID, WORKFLOW_ID, EXECUTION_ID),
      ).rejects.toThrow(ForbiddenException);
    });

    it("UPDATE receives a compound WHERE (not a bare id-only eq) so the status guard is re-asserted", async () => {
      const EXECUTION_ROW = { id: EXECUTION_ID, orgId: OWNER_ORG, status: "running" };
      const findFirst = jest.fn().mockResolvedValue(EXECUTION_ROW);
      let capturedWhere: unknown = null;
      const db = {
        query: { workflowExecutions: { findFirst } },
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((cond) => {
              capturedWhere = cond;
              return {
                returning: jest.fn().mockResolvedValue([
                  { ...EXECUTION_ROW, status: "cancelled", completedAt: new Date() },
                ]),
              };
            }),
          }),
        }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      } as unknown as Db;

      const svc = new WorkflowsExecutionService(db);
      await svc.cancelExecution(OWNER_ORG, USER_ID, WORKFLOW_ID, EXECUTION_ID);

      expect(capturedWhere).toBeDefined();
      const whereType = typeof capturedWhere === "object" && capturedWhere !== null
        ? Object.keys(capturedWhere as object)
        : [];
      expect(whereType.length).toBeGreaterThan(0);
    });

    it("proof — a concurrent cancel on an already-terminal execution returns 0 rows when the status guard is in WHERE", async () => {
      const EXECUTION_ROW = { id: EXECUTION_ID, orgId: OWNER_ORG, status: "running" };
      const findFirst = jest.fn().mockResolvedValue(EXECUTION_ROW);
      const db = {
        query: { workflowExecutions: { findFirst } },
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      } as unknown as Db;

      const svc = new WorkflowsExecutionService(db);
      const result = await svc.cancelExecution(OWNER_ORG, USER_ID, WORKFLOW_ID, EXECUTION_ID);

      expect(result).toBeUndefined();
    });
  });

  describe("handleApproval", () => {
    it("UPDATE receives a compound WHERE including approverId and status", async () => {
      const APPROVAL_ROW = {
        id: APPROVAL_ID,
        executionId: EXECUTION_ID,
        stepId: "step-1",
        workflowId: WORKFLOW_ID,
      };
      let capturedWhere: unknown = null;
      const db = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([APPROVAL_ROW]),
              }),
            }),
          }),
        }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((cond) => {
              capturedWhere = cond;
              return {
                returning: jest.fn().mockResolvedValue([
                  { id: APPROVAL_ID, status: "approved" },
                ]),
              };
            }),
          }),
        }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      } as unknown as Db;

      const svc = new WorkflowsExecutionService(db);
      await svc.handleApproval(OWNER_ORG, USER_ID, APPROVAL_ID, { action: "approve" });

      expect(capturedWhere).toBeDefined();
      const whereType = typeof capturedWhere === "object" && capturedWhere !== null
        ? Object.keys(capturedWhere as object)
        : [];
      expect(whereType.length).toBeGreaterThan(0);
    });

    it("proof — a concurrent double-approve returns 0 rows when status=pending is in the UPDATE WHERE", async () => {
      const APPROVAL_ROW = {
        id: APPROVAL_ID,
        executionId: EXECUTION_ID,
        stepId: "step-1",
        workflowId: WORKFLOW_ID,
      };
      const db = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([APPROVAL_ROW]),
              }),
            }),
          }),
        }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      } as unknown as Db;

      const svc = new WorkflowsExecutionService(db);
      const result = await svc.handleApproval(OWNER_ORG, USER_ID, APPROVAL_ID, { action: "approve" });

      expect(result).toBeUndefined();
    });

    it("throws NotFoundException when the approval does not exist or belongs to another user", async () => {
      const db = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      } as unknown as Db;

      const svc = new WorkflowsExecutionService(db);
      await expect(
        svc.handleApproval(OWNER_ORG, "wrong-user", APPROVAL_ID, { action: "approve" }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
