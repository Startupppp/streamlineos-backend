import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { WorkflowsExecutionService } from "../workflows-execution.service";

const OWNER_ORG = "org-owner-uuid";
const ATTACKER_ORG = "org-attacker-uuid";
const USER_ID = "user-uuid-1";
const APPROVAL_ID = "approval-uuid-1";

const APPROVAL_ROW = {
  id: APPROVAL_ID,
  executionId: "exec-uuid-1",
  stepId: "step-uuid-1",
  workflowId: "wf-uuid-1",
};

function buildSelectChain(rows: unknown[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ innerJoin });
  const select = jest.fn().mockReturnValue({ from });
  return { select, from, innerJoin, where, limit };
}

describe("WorkflowsExecutionService — handleApproval ORACLE-2 existence oracle fix", () => {
  it("throws NotFoundException for a cross-tenant probe (not ForbiddenException)", async () => {
    const chain = buildSelectChain([]);
    const db = { select: chain.select } as unknown as Db;
    const svc = new WorkflowsExecutionService(db);

    await expect(
      svc.handleApproval(ATTACKER_ORG, USER_ID, APPROVAL_ID, { action: "approve" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException (not ForbiddenException) when approval is not found", async () => {
    const chain = buildSelectChain([]);
    const db = { select: chain.select } as unknown as Db;
    const svc = new WorkflowsExecutionService(db);

    let thrownError: unknown;
    try {
      await svc.handleApproval(OWNER_ORG, USER_ID, "nonexistent-id", { action: "approve" });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(NotFoundException);
  });

  it("proof — without orgId in the query, a cross-tenant row creates an oracle", async () => {
    const crossTenantRow = { ...APPROVAL_ROW };
    const chain = buildSelectChain([crossTenantRow]);

    const db = { select: chain.select } as unknown as Db;
    const svc = new WorkflowsExecutionService(db);

    await expect(
      svc.handleApproval(ATTACKER_ORG, USER_ID, APPROVAL_ID, { action: "approve" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("processes the approval for the owning org and returns the updated row", async () => {
    const findQuery = buildSelectChain([APPROVAL_ROW]);

    const returning = jest.fn().mockResolvedValue([{ id: APPROVAL_ID, status: "approved" }]);
    const updateWhere = jest.fn().mockReturnValue({ returning });
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const update = jest.fn().mockReturnValue({ set: updateSet });

    const insertValues = jest.fn().mockResolvedValue(undefined);
    const insert = jest.fn().mockReturnValue({ values: insertValues });

    const db = {
      select: findQuery.select,
      update,
      insert,
    } as unknown as Db;

    const svc = new WorkflowsExecutionService(db);
    const result = await svc.handleApproval(OWNER_ORG, USER_ID, APPROVAL_ID, { action: "approve" });

    expect(result).toMatchObject({ id: APPROVAL_ID, status: "approved" });
    expect(insert).toHaveBeenCalledTimes(1);
    const [logRow] = insertValues.mock.calls[0] as [Record<string, unknown>];
    expect(logRow.orgId).toBe(OWNER_ORG);
    expect(logRow.event).toBe("approved");
  });
});
