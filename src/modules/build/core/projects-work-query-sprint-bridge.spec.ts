import { ProjectsWorkQueryService } from "./projects-work-query.service";
import type { Db } from "../../../db/drizzle.module";
import type { AllWorkQuery } from "./dto/projects.schemas";

const ORG = "org-1";
const BASE_QUERY = { limit: 25, orderBy: "created", scope: "all" } as AllWorkQuery;

function makeUser() {
  return {
    orgId: ORG,
    userId: "u1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: { kind: "human-session" as const, membershipId: 1, isOrgOwner: false },
  };
}

const CYCLE_ID = 3;
const LEGACY_SPRINT_ID = 7;

const ticketRow = {
  id: 1, title: "Task A", status: "TODO", priority: "MEDIUM", type: "TASK",
  dueDate: null, startDate: null, ticketNumber: 1, points: null, estimate: null,
  rank: null, createdAt: new Date("2024-01-01"), updatedAt: new Date("2024-01-01"),
  assigneeId: null, assigneeName: null, assigneeFirstName: null,
  assigneeLastName: null, assigneeEmail: null, assigneeImage: null,
  cycleId: CYCLE_ID, epicId: null, projectId: 10, projectKey: "PROJ", projectName: "Project",
};

function buildDb(cycleEnrichmentResult: { id: number; legacySprintId: number | null }[]) {
  const memberWhere = jest.fn().mockResolvedValue([{ projectId: 10 }]);
  const memberInnerJoin = jest.fn().mockReturnValue({ where: memberWhere });
  const memberFrom = jest.fn().mockReturnValue({ innerJoin: memberInnerJoin });

  const ticketLimit = jest.fn().mockResolvedValue([ticketRow]);
  const ticketOrderBy = jest.fn().mockReturnValue({ limit: ticketLimit });
  const ticketWhere = jest.fn().mockReturnValue({ orderBy: ticketOrderBy });
  const ticketLeftJoin2 = jest.fn().mockReturnValue({ where: ticketWhere });
  const ticketLeftJoin1 = jest.fn().mockReturnValue({ leftJoin: ticketLeftJoin2 });
  const ticketInnerJoin = jest.fn().mockReturnValue({ leftJoin: ticketLeftJoin1 });
  const ticketFrom = jest.fn().mockReturnValue({ innerJoin: ticketInnerJoin });

  const countWhere = jest.fn().mockResolvedValue([{ total: "1" }]);
  const countInnerJoin = jest.fn().mockReturnValue({ where: countWhere });
  const countFrom = jest.fn().mockReturnValue({ innerJoin: countInnerJoin });

  const cycleWhere = jest.fn().mockResolvedValue(cycleEnrichmentResult);
  const cycleFrom = jest.fn().mockReturnValue({ where: cycleWhere });

  const labelWhere = jest.fn().mockResolvedValue([]);
  const labelInnerJoin = jest.fn().mockReturnValue({ where: labelWhere });
  const labelFrom = jest.fn().mockReturnValue({ innerJoin: labelInnerJoin });

  const select = jest.fn()
    .mockReturnValueOnce({ from: memberFrom })
    .mockReturnValueOnce({ from: ticketFrom })
    .mockReturnValueOnce({ from: countFrom })
    .mockReturnValueOnce({ from: cycleFrom })
    .mockReturnValueOnce({ from: labelFrom });

  return { select } as unknown as Db;
}

describe("ProjectsWorkQueryService — sprintId backward-compat projection", () => {
  it("work row carries sprintId === legacySprintId of its cycle so frontend sprint grouping keeps working after tickets.sprint_id is dropped", async () => {
    const db = buildDb([{ id: CYCLE_ID, legacySprintId: LEGACY_SPRINT_ID }]);
    const svc = new ProjectsWorkQueryService(db);
    const result = await svc.getAllWork(makeUser(), BASE_QUERY);

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.sprintId).toBe(LEGACY_SPRINT_ID);
  });

  it("work row with no cycle has sprintId === null — unassigned tickets are unaffected", async () => {
    const noSprintTicket = { ...ticketRow, cycleId: null };
    const memberWhere = jest.fn().mockResolvedValue([{ projectId: 10 }]);
    const memberFrom = jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where: memberWhere }) });
    const ticketLimit = jest.fn().mockResolvedValue([noSprintTicket]);
    const ticketWhere = jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit: ticketLimit }) });
    const ticketFrom = jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnValue({ leftJoin: jest.fn().mockReturnValue({ where: ticketWhere }) }),
      }),
    });
    const countFrom = jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ total: "1" }]) }) });
    const labelFrom = jest.fn().mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) });
    const select = jest.fn()
      .mockReturnValueOnce({ from: memberFrom })
      .mockReturnValueOnce({ from: ticketFrom })
      .mockReturnValueOnce({ from: countFrom })
      .mockReturnValueOnce({ from: labelFrom });

    const db = { select } as unknown as Db;
    const svc = new ProjectsWorkQueryService(db);
    const result = await svc.getAllWork(makeUser(), BASE_QUERY);

    expect(result.data[0]?.sprintId).toBeNull();
  });

  it("mutation proof — hardcoding sprintId: null rather than deriving it breaks sprint grouping on a cycle-bound ticket", async () => {
    const db = buildDb([{ id: CYCLE_ID, legacySprintId: LEGACY_SPRINT_ID }]);
    const svc = new ProjectsWorkQueryService(db);
    const result = await svc.getAllWork(makeUser(), BASE_QUERY);

    expect(result.data[0]?.sprintId).not.toBeNull();
    expect(result.data[0]?.sprintId).toBe(LEGACY_SPRINT_ID);
  });
});
