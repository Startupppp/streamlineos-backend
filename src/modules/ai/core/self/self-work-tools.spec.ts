import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { z } from "zod";
import { SelfWorkTools } from "./self-work-tools";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { ProjectsWorkQueryService } from "../../../build/core/projects-work-query.service";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { AskOsActor } from "../services/ask-os-actor";
import type { AskOsToolRunContext } from "../registry/ask-os-tool.types";

const CALLER: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

const ACTOR: AskOsActor = {
  userId: "user-1",
  orgId: "org-1",
  membershipId: 42,
  displayName: "Test User",
  email: "test@example.com",
  orgName: "Test Org",
  role: "MEMBER",
  isOrgOwner: false,
  timezone: "UTC",
  today: "2026-09-19",
  monthStart: "2026-09-01",
  monthEnd: "2026-09-30",
  currentYear: 2026,
  currentMonth: 9,
};

function makeCtx(overrides: Partial<AskOsToolRunContext> = {}): AskOsToolRunContext {
  return {
    actor: ACTOR,
    caller: CALLER,
    scope: "own",
    scopes: {},
    modules: {},
    ...overrides,
  };
}

type AllWorkResult = Awaited<ReturnType<ProjectsWorkQueryService["getAllWork"]>>;

function emptyWorkResult(): AllWorkResult {
  return { data: [], limit: 25, nextCursor: null, hasMore: false, total: 0 };
}

function workResultWithRows(count: number, hasMore = false): AllWorkResult {
  const data = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    title: `Ticket ${i + 1}`,
    status: i % 3 === 0 ? "DONE" : "TODO",
    priority: "LOW" as const,
    type: "TASK" as const,
    dueDate: null,
    startDate: null,
    ticketNumber: i + 1,
    points: null,
    estimate: null,
    rank: `0|${i}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    assigneeId: null,
    sprintId: null,
    cycleId: null,
    epicId: null,
    projectId: 10,
    projectKey: "P",
    projectName: "Alpha",
    assignee: null,
    labels: [] as { id: number; name: string; color: string }[],
  }));
  return { data, limit: count, nextCursor: null, hasMore, total: count };
}

function makeSelectChain(rows: unknown[]) {
  const chain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  return { select: jest.fn().mockReturnValue(chain), chain };
}

async function buildSut(
  getAllWorkResult: AllWorkResult = emptyWorkResult(),
  dbRows: unknown[] = [],
) {
  const getAllWorkMock = jest.fn().mockResolvedValue(getAllWorkResult);
  const { select, chain } = makeSelectChain(dbRows);
  const dbMock = { select };

  const moduleRef = await Test.createTestingModule({
    providers: [
      SelfWorkTools,
      { provide: DRIZZLE, useValue: dbMock },
      {
        provide: ProjectsWorkQueryService,
        useValue: { getAllWork: getAllWorkMock },
      },
    ],
  }).compile();

  const sut = moduleRef.get(SelfWorkTools);
  const tools = sut.tools();
  return { sut, tools, getAllWorkMock, dbMock, chain };
}

function findTool(tools: ReturnType<SelfWorkTools["tools"]>, key: string) {
  const tool = tools.find((d) => d.key === key);
  if (!tool) throw new Error(`Tool not found: ${key}`);
  return tool;
}

const SUBJECT_KEYS = [
  "userId",
  "actorId",
  "memberId",
  "membershipId",
  "creatorId",
  "authorId",
  "reporterId",
];

describe("SelfWorkTools — input schema safety: no tool exposes a subject identifier", () => {
  it("every tool's input schema omits all subject-identifying fields", async () => {
    expect.hasAssertions();
    const { tools } = await buildSut();
    for (const tool of tools) {
      expect(tool.input instanceof z.ZodObject).toBe(true);
      if (tool.input instanceof z.ZodObject) {
        const presentKeys = Object.keys(tool.input.shape);
        for (const subjectKey of SUBJECT_KEYS) {
          expect(presentKeys).not.toContain(subjectKey);
        }
      }
    }
  });
});

describe("SelfWorkTools.getMyTickets — scope: mine includes co-assigned tickets", () => {
  it("delegates to getAllWork with scope: mine so the union path covers ticket_assignees", async () => {
    expect.hasAssertions();
    const { tools, getAllWorkMock } = await buildSut(workResultWithRows(3));
    const tool = findTool(tools, "getMyTickets");

    await tool.run({ limit: 25, status: undefined }, makeCtx());

    expect(getAllWorkMock).toHaveBeenCalledWith(
      CALLER,
      expect.objectContaining({ scope: "mine" }),
    );
  });

  it("binds the call to ctx.caller — never to a tool-input subject", async () => {
    expect.hasAssertions();
    const { tools, getAllWorkMock } = await buildSut(workResultWithRows(1));
    const tool = findTool(tools, "getMyTickets");

    await tool.run({ limit: 10, status: undefined }, makeCtx());

    const [callerArg] = getAllWorkMock.mock.calls[0] as [unknown, unknown];
    expect(callerArg).toBe(CALLER);
  });

  it("returns empty() when there are no tickets rather than failed()", async () => {
    expect.hasAssertions();
    const { tools } = await buildSut(emptyWorkResult());
    const tool = findTool(tools, "getMyTickets");

    const result = await tool.run({ limit: 25, status: undefined }, makeCtx());

    expect(result.kind).toBe("empty");
  });

  it("sends the model a projected row, because the board row bills the caller for tokens it cannot use", async () => {
    expect.hasAssertions();
    const { tools } = await buildSut(workResultWithRows(1));
    const tool = findTool(tools, "getMyTickets");

    const result = await tool.run({ limit: 25, status: undefined }, makeCtx());

    if (result.kind !== "data") throw new Error(`expected data, got ${result.kind}`);
    const tickets = (result.data as { tickets: Record<string, unknown>[] }).tickets;
    expect(Object.keys(tickets[0] ?? {}).sort()).toEqual([
      "dueDate",
      "id",
      "priority",
      "project",
      "ref",
      "status",
      "title",
      "type",
    ]);
  });

  it("keeps the numeric id, because updateTicketStatus, addTicketComment and assignTicket all take one", async () => {
    expect.hasAssertions();
    const { tools } = await buildSut(workResultWithRows(1));
    const tool = findTool(tools, "getMyTickets");

    const result = await tool.run({ limit: 25, status: undefined }, makeCtx());

    if (result.kind !== "data") throw new Error(`expected data, got ${result.kind}`);
    const tickets = (result.data as { tickets: { id: number; ref: string | null }[] }).tickets;
    expect(tickets[0]?.id).toBe(1);
    expect(tickets[0]?.ref).toBe("P-1");
  });

  it("omits the assignee entirely on scope mine, because every row would repeat the caller", async () => {
    expect.hasAssertions();
    const { tools } = await buildSut(workResultWithRows(2));
    const tool = findTool(tools, "getMyTickets");

    const result = await tool.run({ limit: 25, status: undefined }, makeCtx());

    if (result.kind !== "data") throw new Error(`expected data, got ${result.kind}`);
    const tickets = (result.data as { tickets: Record<string, unknown>[] }).tickets;
    for (const ticket of tickets) expect(ticket).not.toHaveProperty("assignee");
  });

  it("carries no Date object into the model, because one aborts the turn on the ModelMessage schema", async () => {
    expect.hasAssertions();
    const { tools } = await buildSut(workResultWithRows(3));
    const tool = findTool(tools, "getMyTickets");

    const result = await tool.run({ limit: 25, status: undefined }, makeCtx());

    if (result.kind !== "data") throw new Error(`expected data, got ${result.kind}`);
    for (const value of Object.values(
      (result.data as { tickets: Record<string, unknown>[] }).tickets[0] ?? {},
    ))
      expect(value).not.toBeInstanceOf(Date);
  });
});

describe("SelfWorkTools.getMyTicketStats — scope: mine, honest partial flag", () => {
  it("uses scope: mine for co-assigned ticket coverage", async () => {
    expect.hasAssertions();
    const { tools, getAllWorkMock } = await buildSut(workResultWithRows(5));
    const tool = findTool(tools, "getMyTicketStats");

    await tool.run({}, makeCtx());

    expect(getAllWorkMock).toHaveBeenCalledWith(
      CALLER,
      expect.objectContaining({ scope: "mine" }),
    );
  });

  it("sets partial: true when getAllWork reports hasMore", async () => {
    expect.hasAssertions();
    const { tools } = await buildSut(workResultWithRows(100, true));
    const tool = findTool(tools, "getMyTicketStats");

    const result = await tool.run({}, makeCtx());

    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      expect((result.data as { partial: boolean }).partial).toBe(true);
    }
  });
});

describe("SelfWorkTools.getMyCreatedTickets — scope: created, bound to caller", () => {
  it("delegates with scope: created and uses ctx.caller", async () => {
    expect.hasAssertions();
    const { tools, getAllWorkMock } = await buildSut(workResultWithRows(2));
    const tool = findTool(tools, "getMyCreatedTickets");

    await tool.run({ limit: 10 }, makeCtx());

    expect(getAllWorkMock).toHaveBeenCalledWith(
      CALLER,
      expect.objectContaining({ scope: "created" }),
    );
  });
});

describe("SelfWorkTools.getMyCreatedTickets — the assignee is someone else, so it stays", () => {
  it("reports the assignee name only, not the hydrated assignee object", async () => {
    expect.hasAssertions();
    const result0 = workResultWithRows(1);
    const row = result0.data[0];
    if (row) Object.assign(row, { assignee: { id: "u-9", name: "Priya", email: "p@x.test" } });
    const { tools } = await buildSut(result0);
    const tool = findTool(tools, "getMyCreatedTickets");

    const result = await tool.run({ limit: 25 }, makeCtx());

    if (result.kind !== "data") throw new Error(`expected data, got ${result.kind}`);
    const tickets = (result.data as { tickets: Record<string, unknown>[] }).tickets;
    expect(tickets[0]?.assignee).toBe("Priya");
  });
});

describe("SelfWorkTools.getMyReferrals — 200-row cap and honest count", () => {
  it("reports count as '200+' rather than the integer 200 when the result is at the cap", async () => {
    expect.hasAssertions();
    const referralRows = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      candidateId: i + 1,
      status: "SUBMITTED" as const,
      jobPostingId: null,
      createdAt: new Date(),
    }));
    const { tools } = await buildSut(emptyWorkResult(), referralRows);
    const tool = findTool(tools, "getMyReferrals");

    const result = await tool.run({}, makeCtx());

    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      const payload = result.data as { count: string | number; atCap: boolean };
      expect(payload.count).toBe("200+");
      expect(payload.atCap).toBe(true);
    }
  });

  it("reports the exact integer count when below the cap", async () => {
    expect.hasAssertions();
    const referralRows = Array.from({ length: 3 }, (_, i) => ({
      id: i + 1,
      candidateId: i + 1,
      status: "SUBMITTED" as const,
      jobPostingId: null,
      createdAt: new Date(),
    }));
    const { tools } = await buildSut(emptyWorkResult(), referralRows);
    const tool = findTool(tools, "getMyReferrals");

    const result = await tool.run({}, makeCtx());

    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      const payload = result.data as { count: string | number; atCap: boolean };
      expect(payload.count).toBe(3);
      expect(payload.atCap).toBe(false);
    }
  });

  it("returns empty() rather than failed() when there are no referrals", async () => {
    expect.hasAssertions();
    const { tools } = await buildSut(emptyWorkResult(), []);
    const tool = findTool(tools, "getMyReferrals");

    const result = await tool.run({}, makeCtx());

    expect(result.kind).toBe("empty");
  });
});

describe("SelfWorkTools.getMyTasks — bound to caller userId, not input", () => {
  it("returns empty() rather than failed() when there are no open tasks", async () => {
    expect.hasAssertions();
    const { tools } = await buildSut(emptyWorkResult(), []);
    const tool = findTool(tools, "getMyTasks");

    const result = await tool.run({ limit: 25 }, makeCtx());

    expect(result.kind).toBe("empty");
  });

  it("returns data() when tasks exist", async () => {
    expect.hasAssertions();
    const taskRows = [
      { activityId: "a1", subject: "Fix bug", dueAt: null, occurredAt: new Date(), completedAt: null },
    ];
    const { tools } = await buildSut(emptyWorkResult(), taskRows);
    const tool = findTool(tools, "getMyTasks");

    const result = await tool.run({ limit: 25 }, makeCtx());

    expect(result.kind).toBe("data");
  });
});

describe("SelfWorkTools.getMyTimesheets — defaults to actor.monthStart / monthEnd", () => {
  it("returns empty() rather than failed() when there are no entries", async () => {
    expect.hasAssertions();
    const { tools } = await buildSut(emptyWorkResult(), []);
    const tool = findTool(tools, "getMyTimesheets");

    const result = await tool.run({}, makeCtx());

    expect(result.kind).toBe("empty");
  });

  it("uses actor.monthStart and monthEnd when from/to are not provided", async () => {
    expect.hasAssertions();
    const entryRows = [{ id: 1, date: "2026-09-10", hours: "8.00", description: null, status: "PENDING", projectId: null, isBillable: false }];
    const { tools, chain } = await buildSut(emptyWorkResult(), entryRows);
    const tool = findTool(tools, "getMyTimesheets");

    const result = await tool.run({}, makeCtx());

    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      const payload = result.data as { from: string; to: string };
      expect(payload.from).toBe(ACTOR.monthStart);
      expect(payload.to).toBe(ACTOR.monthEnd);
    }
    expect(chain.where).toHaveBeenCalled();
  });
});
