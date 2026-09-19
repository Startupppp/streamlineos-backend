import "reflect-metadata";
import { WorkspaceCopilotTools } from "../workspace-copilot-tools";
import type { AskOsActor } from "../services/ask-os-actor";
import type { AskOsToolRunContext } from "../registry/ask-os-tool.types";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { ProjectsWorkQueryService } from "../../../build/core/projects-work-query.service";

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
  membershipId: 1,
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

type AllWorkResult = Awaited<ReturnType<ProjectsWorkQueryService["getAllWork"]>>;

function ticketRow(overrides: {
  projectId?: number;
  projectName?: string;
  status?: string;
}): AllWorkResult["data"][number] {
  return {
    id: Math.floor(Math.random() * 100000),
    title: "a ticket",
    status: overrides.status ?? "TODO",
    priority: "LOW",
    type: "TASK",
    dueDate: null,
    startDate: null,
    ticketNumber: 1,
    points: null,
    estimate: null,
    rank: "0|aaa",
    createdAt: new Date(),
    updatedAt: new Date(),
    assigneeId: null,
    sprintId: null,
    cycleId: null,
    epicId: null,
    projectId: overrides.projectId ?? 10,
    projectKey: "P",
    projectName: overrides.projectName ?? "Alpha",
    assignee: null,
    labels: [],
  };
}

function makeWorkQuery(
  ticketData: AllWorkResult["data"],
  opts: { hasMore?: boolean; total?: number } = {},
): jest.Mocked<Pick<ProjectsWorkQueryService, "getAllWork">> {
  const result: AllWorkResult = {
    data: ticketData,
    limit: 100,
    nextCursor: null,
    hasMore: opts.hasMore ?? false,
    total: opts.total ?? ticketData.length,
  };
  return { getAllWork: jest.fn().mockResolvedValue(result) };
}

function makeSut(wq: ReturnType<typeof makeWorkQuery>) {
  return new WorkspaceCopilotTools({} as never, {} as never, {} as never, wq as never);
}

function makeCtx(scope: "all" | "own" | "team" | "none" = "all"): AskOsToolRunContext {
  return { actor: ACTOR, caller: CALLER, scope, scopes: {}, modules: {} };
}

function statsToolRun(
  sut: WorkspaceCopilotTools,
): (input: { userId: string; projectId?: number }, scope?: "all" | "own") => Promise<unknown> {
  const def = sut.tools().find((d) => d.key === "getPersonTicketStats")!;
  return (input, scope = "all") => def.run(input, makeCtx(scope));
}

describe("WorkspaceCopilotTools.getPersonTicketStats", () => {
  it("excludes soft-deleted tickets by delegating exclusively to getAllWork with no raw SQL fallback", async () => {
    const ticketData = [
      ticketRow({ status: "TODO" }),
      ticketRow({ status: "DONE" }),
      ticketRow({ status: "IN_PROGRESS" }),
    ];
    const wq = makeWorkQuery(ticketData);
    const run = statsToolRun(makeSut(wq));

    const result = await run({ userId: "user-target" });

    expect(wq.getAllWork).toHaveBeenCalledWith(
      CALLER,
      expect.objectContaining({ assigneeId: ["user-target"] }),
    );
    expect(result).toMatchObject({ kind: "data", data: { totals: { total: 3, done: 1, inProgress: 1 } } });
  });

  it("reports only projects returned by getAllWork, excluding any project the caller has no membership in", async () => {
    const ticketData = [
      ticketRow({ projectId: 10, projectName: "Alpha", status: "DONE" }),
      ticketRow({ projectId: 10, projectName: "Alpha", status: "IN_PROGRESS" }),
    ];
    const wq = makeWorkQuery(ticketData);
    const run = statsToolRun(makeSut(wq));

    const result = await run({ userId: "user-target" }) as {
      kind: "data";
      data: {
        byProject: { projectId: number; projectName: string; total: number; done: number; inProgress: number }[];
        totals: { total: number; done: number; inProgress: number };
      };
    };

    expect(result.kind).toBe("data");
    expect(result.data.byProject).toHaveLength(1);
    expect(result.data.byProject[0]).toMatchObject({ projectId: 10, projectName: "Alpha", total: 2, done: 1, inProgress: 1 });
    expect(result.data.totals).toMatchObject({ total: 2, done: 1, inProgress: 1 });
  });

  it("refuses an own-scoped actor querying a different user", async () => {
    const wq = makeWorkQuery([]);
    const run = statsToolRun(makeSut(wq));

    const result = await run({ userId: "user-other" }, "own");

    expect(result).toMatchObject({ kind: "failed" });
    expect(wq.getAllWork).not.toHaveBeenCalled();
  });

  it("marks result as partial and uses the real total when getAllWork has more pages", async () => {
    const ticketData = Array.from({ length: 100 }, () => ticketRow({ status: "TODO" }));
    const wq = makeWorkQuery(ticketData, { hasMore: true, total: 250 });
    const run = statsToolRun(makeSut(wq));

    const result = await run({ userId: "user-target" }) as {
      kind: "data";
      data: { totals: { total: number }; partial: boolean };
    };

    expect(result.kind).toBe("data");
    expect(result.data.partial).toBe(true);
    expect(result.data.totals.total).toBe(250);
  });
});
