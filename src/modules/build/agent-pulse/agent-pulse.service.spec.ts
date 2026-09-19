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
  const whereResult = { orderBy: orderByFn };
  const whereFn = jest.fn().mockReturnValue(whereResult);
  const innerJoinResult = { where: whereFn };
  const innerJoinFn = jest.fn().mockReturnValue(innerJoinResult);
  const fromResult = { where: whereFn, innerJoin: innerJoinFn };
  const fromFn = jest.fn().mockReturnValue(fromResult);
  return { from: fromFn };
}

describe("AgentPulseService", () => {
  let svc: AgentPulseService;
  let selectMock: jest.Mock;

  beforeEach(async () => {
    jest.resetAllMocks();
    selectMock = jest.fn();
    const module = await Test.createTestingModule({
      providers: [
        AgentPulseService,
        { provide: DRIZZLE, useValue: { select: selectMock } },
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

  it("returns comment_draft as tier-5 signal", async () => {
    const draftRow = {
      entityId: 7,
      projectId: 40,
      title: "Implement feature X",
      updatedAt: new Date("2026-09-18T00:00:00Z"),
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
    expect(selectMock).toHaveBeenCalledTimes(5);
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
});
