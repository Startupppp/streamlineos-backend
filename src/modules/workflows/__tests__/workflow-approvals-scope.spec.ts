import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { WorkflowsApprovalService } from "../workflows-approval.service";

/**
 * The three predicates that decide whose approval is whose, asserted as
 * predicates.
 *
 * `workflow-approval-oracle.spec.ts` checks the OUTCOMES of a cross-tenant probe
 * — 404 not 403 — and it is right to. But its select mock hands back the same
 * rows whatever the query says, so it cannot tell a scoped query from an
 * unscoped one: every one of the five predicates below could be deleted from
 * `workflows-approval.service.ts` with the whole workflows suite green, including
 * the join org predicate that spec names as the thing it proves. An approval is
 * the permission to push someone else's workflow forward, so "anyone in any org
 * can list and action anyone's approvals" was one deleted line away, silently.
 *
 * These assert what reaches `where` / the join condition, because an empty
 * result proves nothing — an unscoped query that happens to match nothing
 * returns the same empty set.
 */

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
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

const ORG = "org-approvals-tenant";
const APPROVER = "user-the-approver";
const APPROVAL_ID = "approval-under-test";

describe("getApprovals — the approver's inbox is scoped to the approver and the org", () => {
  function inboxDb(): { db: Db; where: jest.Mock } {
    const limit = jest.fn().mockResolvedValue([]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const where = jest.fn().mockReturnValue({ orderBy });
    const join3 = jest.fn().mockReturnValue({ where });
    const join2 = jest.fn().mockReturnValue({ innerJoin: join3 });
    const join1 = jest.fn().mockReturnValue({ innerJoin: join2 });
    const from = jest.fn().mockReturnValue({ innerJoin: join1 });
    const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
    return { db, where };
  }

  it("lists only approvals addressed to the caller", async () => {
    const { db, where } = inboxDb();
    await new WorkflowsApprovalService(db).getApprovals(ORG, APPROVER);

    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(APPROVER);
  });

  it("lists only approvals on executions in the caller's org", async () => {
    const { db, where } = inboxDb();
    await new WorkflowsApprovalService(db).getApprovals(ORG, APPROVER);

    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ORG);
  });
});

describe("handleApproval — only the addressed approver, in the right org, may decide", () => {
  function decisionDb(found: unknown[]): {
    db: Db;
    joinOn: jest.Mock;
    selectWhere: jest.Mock;
    updateWhere: jest.Mock;
    update: jest.Mock;
  } {
    const limit = jest.fn().mockResolvedValue(found);
    const selectWhere = jest.fn().mockReturnValue({ limit });
    const joinOn = jest.fn().mockReturnValue({ where: selectWhere });
    const from = jest.fn().mockReturnValue({ innerJoin: joinOn });

    const returning = jest.fn().mockResolvedValue([{ id: APPROVAL_ID, status: "approved" }]);
    const updateWhere = jest.fn().mockReturnValue({ returning });
    const update = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: updateWhere }),
    });

    const db = {
      select: jest.fn().mockReturnValue({ from }),
      update,
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
    } as unknown as Db;
    return { db, joinOn, selectWhere, updateWhere, update };
  }

  const ROW = {
    id: APPROVAL_ID,
    executionId: "exec-1",
    stepId: "step-1",
    workflowId: "wf-1",
  };

  it("reaches the approval only through an execution in the caller's org", async () => {
    const { db, joinOn } = decisionDb([ROW]);
    await new WorkflowsApprovalService(db).handleApproval(ORG, APPROVER, APPROVAL_ID, {
      action: "approve",
    });

    expect(joinOn).toHaveBeenCalledTimes(1);
    expect(sqlValues(joinOn.mock.calls[0]?.[1])).toContain(ORG);
  });

  it("finds the approval only if it is addressed to the caller", async () => {
    const { db, selectWhere } = decisionDb([ROW]);
    await new WorkflowsApprovalService(db).handleApproval(ORG, APPROVER, APPROVAL_ID, {
      action: "approve",
    });

    expect(selectWhere).toHaveBeenCalledTimes(1);
    expect(sqlValues(selectWhere.mock.calls[0]?.[0])).toContain(APPROVER);
  });

  /**
   * Belt and braces, and deliberately so: the read above and this write are two
   * statements, and the write re-asserting the approver means a decision cannot
   * land on a row that changed hands in between.
   */
  it("writes the decision only onto an approval addressed to the caller", async () => {
    const { db, updateWhere } = decisionDb([ROW]);
    await new WorkflowsApprovalService(db).handleApproval(ORG, APPROVER, APPROVAL_ID, {
      action: "approve",
    });

    expect(updateWhere).toHaveBeenCalledTimes(1);
    expect(sqlValues(updateWhere.mock.calls[0]?.[0])).toContain(APPROVER);
  });

  it("writes nothing when the scoped read finds no approval", async () => {
    const { db, update } = decisionDb([]);
    await expect(
      new WorkflowsApprovalService(db).handleApproval(ORG, APPROVER, APPROVAL_ID, {
        action: "approve",
      }),
    ).rejects.toThrow(NotFoundException);

    expect(update).not.toHaveBeenCalled();
  });
});
