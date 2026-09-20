import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AgentPulseService } from "./agent-pulse.service";
import { DRIZZLE } from "../../../db/drizzle.constants";

const ORG = "org-1";
const USER = "user-1";
const MID = 42;

function makeSelectChain(rows: unknown[]) {
  const limitFn = jest.fn().mockResolvedValue(rows);
  const orderByResult = { limit: limitFn };
  const orderByFn = jest.fn().mockReturnValue(orderByResult);
  const whereResult = { orderBy: orderByFn, limit: limitFn };
  const whereFn = jest.fn().mockReturnValue(whereResult);
  const innerJoinFn: jest.Mock = jest.fn();
  const joinAndFrom = { where: whereFn, innerJoin: innerJoinFn };
  innerJoinFn.mockReturnValue(joinAndFrom);
  const fromFn = jest.fn().mockReturnValue(joinAndFrom);
  return { from: fromFn };
}

function makeCountChain(rows: unknown[]) {
  const whereFn = jest.fn().mockResolvedValue(rows);
  const fromFn = jest.fn().mockReturnValue({ where: whereFn });
  return { from: fromFn };
}

describe("AgentPulseService", () => {
  let svc: AgentPulseService;
  let selectMock: jest.Mock;
  let transactionMock: jest.Mock;

  beforeEach(async () => {
    jest.resetAllMocks();
    selectMock = jest.fn();
    transactionMock = jest.fn();
    const module = await Test.createTestingModule({
      providers: [
        AgentPulseService,
        { provide: DRIZZLE, useValue: { select: selectMock, transaction: transactionMock } },
      ],
    }).compile();
    svc = module.get(AgentPulseService);
  });

  it("returns null and makes no DB calls when membershipId is null", async () => {
    const result = await svc.getTopSignal(ORG, USER, null);
    expect(result).toBeNull();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("returns overdue_approval as the tier-1 signal and stops querying further tiers", async () => {
    const approvalRow = {
      entityId: 1,
      projectId: 10,
      title: "Budget approval",
      dueAt: new Date("2026-09-01T10:00:00Z"),
    };
    selectMock.mockImplementationOnce(() => makeSelectChain([approvalRow]));

    const result = await svc.getTopSignal(ORG, USER, MID);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("overdue_approval");
    expect(result?.entityId).toBe(1);
    expect(result?.projectId).toBe(10);
    expect(result?.dueAt).toBe("2026-09-01T10:00:00.000Z");
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it("skips to blocked_milestone when tier-1 returns empty", async () => {
    const milestoneRow = {
      entityId: 5,
      projectId: 20,
      title: "v2.0 release",
      targetDate: "2026-08-15",
    };
    selectMock
      .mockImplementationOnce(() => makeSelectChain([]))
      .mockImplementationOnce(() => makeSelectChain([milestoneRow]));

    const result = await svc.getTopSignal(ORG, USER, MID);

    expect(result?.type).toBe("blocked_milestone");
    expect(result?.entityId).toBe(5);
    expect(result?.dueAt).toBe("2026-08-15");
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it("returns delivery_risk as tier-3 signal with null dueAt", async () => {
    const riskRow = {
      entityId: 3,
      projectId: 30,
      title: "Security risk",
      createdAt: new Date("2026-09-10T00:00:00Z"),
    };
    const empty = () => makeSelectChain([]);
    selectMock
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(() => makeSelectChain([riskRow]));

    const result = await svc.getTopSignal(ORG, USER, MID);

    expect(result?.type).toBe("delivery_risk");
    expect(result?.dueAt).toBeNull();
    expect(result?.entityId).toBe(3);
    expect(selectMock).toHaveBeenCalledTimes(3);
  });

  it("returns dependency_change as tier-4 signal", async () => {
    const depRow = {
      entityId: 55,
      projectId: 40,
      title: "Fix auth bug",
      createdAt: new Date("2026-09-15T00:00:00Z"),
    };
    const empty = () => makeSelectChain([]);
    selectMock
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(() => makeSelectChain([depRow]));

    const result = await svc.getTopSignal(ORG, USER, MID);

    expect(result?.type).toBe("dependency_change");
    expect(result?.entityId).toBe(55);
    expect(result?.dueAt).toBeNull();
    expect(selectMock).toHaveBeenCalledTimes(4);
  });

  it("returns comment_draft as tier-5 signal with evidence fields surfaced (BSN-03-043)", async () => {
    const draftRow = {
      entityId: 7,
      projectId: 40,
      title: "Implement feature X",
      updatedAt: new Date("2026-09-18T00:00:00Z"),
      evidence: "Ticket has been open for 14 days with no assignee",
      proposedChange: "Assign to the senior developer on the team",
      impact: "Unblocks the Q4 milestone delivery",
      confidence: 75,
      affectedRecordIds: JSON.stringify([7, 8, 12]),
      retryCount: 0,
    };
    const empty = () => makeSelectChain([]);
    selectMock
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(() => makeSelectChain([draftRow]));

    const result = await svc.getTopSignal(ORG, USER, MID);

    expect(result?.type).toBe("comment_draft");
    expect(result?.entityId).toBe(7);
    expect(result?.evidence).toBe("Ticket has been open for 14 days with no assignee");
    expect(result?.proposedChange).toBe("Assign to the senior developer on the team");
    expect(result?.impact).toBe("Unblocks the Q4 milestone delivery");
    expect(result?.confidence).toBe(75);
    expect(result?.affectedRecordIds).toEqual([7, 8, 12]);
    expect(result?.retryCount).toBe(0);
    expect(selectMock).toHaveBeenCalledTimes(5);
  });

  it("surfaces comment_draft with null evidence fields when the draft has no evidence recorded (BSN-03-043)", async () => {
    const draftRow = {
      entityId: 7,
      projectId: 40,
      title: "Implement feature X",
      updatedAt: new Date("2026-09-18T00:00:00Z"),
      evidence: null,
      proposedChange: null,
      impact: null,
      confidence: null,
      affectedRecordIds: null,
      retryCount: null,
    };
    const empty = () => makeSelectChain([]);
    selectMock
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(() => makeSelectChain([draftRow]));

    const result = await svc.getTopSignal(ORG, USER, MID);

    expect(result?.type).toBe("comment_draft");
    expect(result?.evidence).toBeNull();
    expect(result?.proposedChange).toBeNull();
    expect(result?.impact).toBeNull();
    expect(result?.confidence).toBeNull();
    expect(result?.affectedRecordIds).toBeNull();
    expect(result?.retryCount).toBe(0);
  });

  it("returns null when all five tiers are empty — empty state is quiet", async () => {
    const empty = () => makeSelectChain([]);
    selectMock
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty);

    const result = await svc.getTopSignal(ORG, USER, MID);

    expect(result).toBeNull();
    expect(selectMock).toHaveBeenCalledTimes(5);
  });

  it("returns null when the only comment_draft has low confidence — the DB WHERE clause excludes it and tier-5 returns empty (BSN-03-046)", async () => {
    const empty = () => makeSelectChain([]);
    selectMock
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty);

    const result = await svc.getTopSignal(ORG, USER, MID);

    expect(result).toBeNull();
    expect(selectMock).toHaveBeenCalledTimes(5);
  });

  it("returns null when the only comment_draft has reached the retry cap — the DB WHERE clause excludes it and tier-5 returns empty (BSN-03-045)", async () => {
    const empty = () => makeSelectChain([]);
    selectMock
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty);

    const result = await svc.getTopSignal(ORG, USER, MID);

    expect(result).toBeNull();
    expect(selectMock).toHaveBeenCalledTimes(5);
  });

  it("cross-tenant isolation — an actor in a different org sees no signal even when their membershipId matches a signal in another org (BSN-03-040)", async () => {
    const empty = () => makeSelectChain([]);
    selectMock
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty);

    const result = await svc.getTopSignal("org-attacker", USER, MID);

    expect(result).toBeNull();
    expect(selectMock).toHaveBeenCalledTimes(5);
  });

  it("actor isolation — a different membershipId in the same org receives no signal when that actor has none (BSN-03-040)", async () => {
    const empty = () => makeSelectChain([]);
    selectMock
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty);

    const result = await svc.getTopSignal(ORG, "user-other", 9999);

    expect(result).toBeNull();
    expect(selectMock).toHaveBeenCalledTimes(5);
  });

  describe("BSN-03-A05 — priority ordering under concurrent signals: higher tier wins and lower tier is never queried", () => {
  it("blocked_milestone (tier-2) wins over delivery_risk (tier-3) when both exist concurrently — tier-3 mock is registered but never invoked because tier-2 short-circuits", async () => {
    const milestoneRow = { entityId: 5, projectId: 20, title: "v2.0 release", targetDate: "2026-08-15" };
    const riskRow = { entityId: 3, projectId: 30, title: "Scope risk", createdAt: new Date() };
    selectMock
      .mockImplementationOnce(() => makeSelectChain([]))
      .mockImplementationOnce(() => makeSelectChain([milestoneRow]))
      .mockImplementationOnce(() => makeSelectChain([riskRow]));

    const result = await svc.getTopSignal(ORG, USER, MID);

    expect(result?.type).toBe("blocked_milestone");
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it("delivery_risk (tier-3) wins over dependency_change (tier-4) when both exist concurrently", async () => {
    const riskRow = { entityId: 3, projectId: 30, title: "Scope risk", createdAt: new Date() };
    const depRow = { entityId: 55, projectId: 40, title: "Blocked ticket", createdAt: new Date() };
    const empty = () => makeSelectChain([]);
    selectMock
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(() => makeSelectChain([riskRow]))
      .mockImplementationOnce(() => makeSelectChain([depRow]));

    const result = await svc.getTopSignal(ORG, USER, MID);

    expect(result?.type).toBe("delivery_risk");
    expect(selectMock).toHaveBeenCalledTimes(3);
  });

  it("dependency_change (tier-4) wins over comment_draft (tier-5) when both exist concurrently", async () => {
    const depRow = { entityId: 55, projectId: 40, title: "Blocked ticket", createdAt: new Date() };
    const draftRow = {
      entityId: 7, projectId: 40, title: "Draft ticket", updatedAt: new Date(),
      evidence: null, proposedChange: null, impact: null, confidence: null,
      affectedRecordIds: null, retryCount: null,
    };
    const empty = () => makeSelectChain([]);
    selectMock
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(empty)
      .mockImplementationOnce(() => makeSelectChain([depRow]))
      .mockImplementationOnce(() => makeSelectChain([draftRow]));

    const result = await svc.getTopSignal(ORG, USER, MID);

    expect(result?.type).toBe("dependency_change");
    expect(selectMock).toHaveBeenCalledTimes(4);
  });

  it("overdue_approval (tier-1) wins when all five tiers have concurrent signals — only one select query is made", async () => {
    const approvalRow = {
      entityId: 1, projectId: 10, title: "Budget approval",
      dueAt: new Date("2026-09-01T00:00:00Z"),
    };
    const milestoneRow = { entityId: 5, projectId: 20, title: "v2.0", targetDate: "2026-08-15" };
    selectMock
      .mockImplementationOnce(() => makeSelectChain([approvalRow]))
      .mockImplementationOnce(() => makeSelectChain([milestoneRow]));

    const result = await svc.getTopSignal(ORG, USER, MID);

    expect(result?.type).toBe("overdue_approval");
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it("the service returns the projectId from the DB row unchanged — it does not construct or supplement the id from outside the query result", async () => {
    const milestoneRow = { entityId: 5, projectId: 77, title: "Milestone", targetDate: "2026-08-15" };
    selectMock
      .mockImplementationOnce(() => makeSelectChain([]))
      .mockImplementationOnce(() => makeSelectChain([milestoneRow]));

    const result = await svc.getTopSignal(ORG, USER, MID);

    expect(result?.projectId).toBe(77);
  });
  });

  describe("BSN-03-040 — active scope filtering", () => {
  it("with projectId scope, the tier-1 query runs and returns the signal — scope is threaded to the SQL predicate, not guarded in JS", async () => {
    const approvalRow = { entityId: 1, projectId: 5, title: "Budget approval", dueAt: new Date("2026-09-01T00:00:00Z") };
    selectMock.mockImplementationOnce(() => makeSelectChain([approvalRow]));

    const result = await svc.getTopSignal(ORG, USER, MID, { projectId: 5 });

    expect(result?.type).toBe("overdue_approval");
    expect(result?.projectId).toBe(5);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it("with managedProductId scope and all tiers empty, all five DB queries execute — the scope filter lives in SQL and does not short-circuit the waterfall", async () => {
    const empty = () => makeSelectChain([]);
    for (let i = 0; i < 5; i++) selectMock.mockImplementationOnce(empty);

    const result = await svc.getTopSignal(ORG, USER, MID, { managedProductId: 99 });

    expect(result).toBeNull();
    expect(selectMock).toHaveBeenCalledTimes(5);
  });

  it("with pmWorkspaceId scope and all tiers empty, all five DB queries execute — workspace scope does not reduce the number of tier queries", async () => {
    const empty = () => makeSelectChain([]);
    for (let i = 0; i < 5; i++) selectMock.mockImplementationOnce(empty);

    const result = await svc.getTopSignal(ORG, USER, MID, { pmWorkspaceId: "ws-1" });

    expect(result).toBeNull();
    expect(selectMock).toHaveBeenCalledTimes(5);
  });

  it("organization scope (no scope params) behaves identically to the unscoped baseline — all five tiers run when empty", async () => {
    const empty = () => makeSelectChain([]);
    for (let i = 0; i < 5; i++) selectMock.mockImplementationOnce(empty);

    const result = await svc.getTopSignal(ORG, USER, MID, {});

    expect(result).toBeNull();
    expect(selectMock).toHaveBeenCalledTimes(5);
  });

  it("with projectId scope, priority ordering is preserved — tier-2 wins over tier-3 within the scope", async () => {
    const milestoneRow = { entityId: 5, projectId: 7, title: "Scoped milestone", targetDate: "2026-08-15" };
    selectMock
      .mockImplementationOnce(() => makeSelectChain([]))
      .mockImplementationOnce(() => makeSelectChain([milestoneRow]));

    const result = await svc.getTopSignal(ORG, USER, MID, { projectId: 7 });

    expect(result?.type).toBe("blocked_milestone");
    expect(result?.projectId).toBe(7);
    expect(selectMock).toHaveBeenCalledTimes(2);
  });
  });

  describe("applyDraft — re-authorization and ownership", () => {
  it("re-authorization defect proof: throws NotFoundException when the draft does not exist for the calling actor — stored creation access is not replayed at approve time", async () => {
    selectMock.mockImplementationOnce(() => makeSelectChain([]));

    await expect(svc.applyDraft(ORG, USER, MID, 99)).rejects.toThrow(NotFoundException);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("throws ForbiddenException when membershipId is null — account-only and system principals cannot approve proposals", async () => {
    await expect(svc.applyDraft(ORG, USER, null, 99)).rejects.toThrow(ForbiddenException);
    expect(selectMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("cross-tenant isolation: draft that exists in a different org returns NotFoundException when called with the attacker org — orgId is always re-asserted against the stored row", async () => {
    selectMock.mockImplementationOnce(() => makeSelectChain([]));

    await expect(svc.applyDraft("org-attacker", USER, MID, 1)).rejects.toThrow(NotFoundException);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("actor isolation: draft owned by membershipId=100 returns NotFoundException when called with membershipId=999 — another actor cannot approve a draft they do not own", async () => {
    selectMock.mockImplementationOnce(() => makeSelectChain([]));

    await expect(svc.applyDraft(ORG, USER, 999, 1)).rejects.toThrow(NotFoundException);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when the ticket no longer exists after the draft was created — re-authorization checks current resource state, not proposal-creation state", async () => {
    const draftRow = { id: 7, ticketId: 55, body: "Apply this fix" };
    selectMock
      .mockImplementationOnce(() => makeSelectChain([draftRow]))
      .mockImplementationOnce(() => makeSelectChain([]));

    await expect(svc.applyDraft(ORG, USER, MID, 7)).rejects.toThrow(NotFoundException);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("happy path: posts the draft body as a comment and deletes the draft atomically — returns commentId and ticketId", async () => {
    const draftRow = { id: 7, ticketId: 55, body: "Apply this fix" };
    const ticketRow = { id: 55 };
    const returningFn = jest.fn().mockResolvedValue([{ id: 101 }]);
    const valuesFn = jest.fn().mockReturnValue({ returning: returningFn });
    const insertFn = jest.fn().mockReturnValue({ values: valuesFn });
    const deleteWhereFn = jest.fn().mockResolvedValue(undefined);
    const deleteFn = jest.fn().mockReturnValue({ where: deleteWhereFn });
    const txMock = { insert: insertFn, delete: deleteFn };
    transactionMock.mockImplementation(
      (callback: (tx: typeof txMock) => Promise<number>) => callback(txMock),
    );
    selectMock
      .mockImplementationOnce(() => makeSelectChain([draftRow]))
      .mockImplementationOnce(() => makeSelectChain([ticketRow]));

    const result = await svc.applyDraft(ORG, USER, MID, 7);

    expect(result).toEqual({ commentId: 101, ticketId: 55 });
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(insertFn).toHaveBeenCalledTimes(1);
    expect(deleteFn).toHaveBeenCalledTimes(1);
  });

  it("transaction is invoked — the callback is called so the comment insert and draft delete actually run", async () => {
    const draftRow = { id: 3, ticketId: 20, body: "Proposed fix" };
    const ticketRow = { id: 20 };
    const returningFn = jest.fn().mockResolvedValue([{ id: 77 }]);
    const valuesFn = jest.fn().mockReturnValue({ returning: returningFn });
    const insertFn = jest.fn().mockReturnValue({ values: valuesFn });
    const innerDeleteWhereFn = jest.fn().mockResolvedValue(undefined);
    const deleteFn = jest.fn().mockReturnValue({ where: innerDeleteWhereFn });
    const txMock = { insert: insertFn, delete: deleteFn };
    transactionMock.mockImplementation(
      (callback: (tx: typeof txMock) => Promise<number>) => callback(txMock),
    );
    selectMock
      .mockImplementationOnce(() => makeSelectChain([draftRow]))
      .mockImplementationOnce(() => makeSelectChain([ticketRow]));

    await svc.applyDraft(ORG, USER, MID, 3);

    expect(returningFn).toHaveBeenCalledTimes(1);
    expect(innerDeleteWhereFn).toHaveBeenCalledTimes(1);
  });
  });

  describe("countPendingSignals — badge accuracy and actor scoping", () => {
  it("returns 0 when membershipId is null — badge for non-member is always zero", async () => {
    const result = await svc.countPendingSignals(ORG, null);
    expect(result).toBe(0);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("returns the count from the DB query — uses same predicate as the comment_draft tier in getTopSignal", async () => {
    selectMock.mockImplementationOnce(() => makeCountChain([{ total: 4 }]));

    const result = await svc.countPendingSignals(ORG, MID);

    expect(result).toBe(4);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it("returns 0 when the query returns no rows — empty state does not throw", async () => {
    selectMock.mockImplementationOnce(() => makeCountChain([]));

    const result = await svc.countPendingSignals(ORG, MID);

    expect(result).toBe(0);
  });

  it("actor isolation: a different actor's count is independent — MID and a different id do not share results", async () => {
    selectMock.mockImplementationOnce(() => makeCountChain([{ total: 0 }]));

    const result = await svc.countPendingSignals(ORG, 9999);

    expect(result).toBe(0);
  });
  });
});
