import "reflect-metadata";
import { WorkspaceCopilotTools } from "./workspace-copilot-tools";
import type { AskOsActor } from "../services/ask-os-actor";
import type { AskOsToolRunContext } from "../registry/ask-os-tool.types";
import { ScopedRead } from "../../../access/scoped-read";
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

type CountByProjectResult = Awaited<ReturnType<ProjectsWorkQueryService["countTicketsByProjectAndStatus"]>>;

function makeWorkQuery(
  result: CountByProjectResult,
): jest.Mocked<Pick<ProjectsWorkQueryService, "countTicketsByProjectAndStatus">> {
  return { countTicketsByProjectAndStatus: jest.fn().mockResolvedValue(result) };
}

function makeSut(wq: ReturnType<typeof makeWorkQuery>) {
  return new WorkspaceCopilotTools({} as never, {} as never, {} as never, wq as never);
}

function makeCtx(scope: "all" | "own" | "team" | "none" = "all"): AskOsToolRunContext {
  const read = ScopedRead.of(ACTOR.orgId, ACTOR.userId, scope);
  return { actor: ACTOR, caller: CALLER, read, readFor: () => read, modules: {} };
}

function statsToolRun(
  sut: WorkspaceCopilotTools,
): (input: { userId: string; projectId?: number }, scope?: "all" | "own") => Promise<unknown> {
  const def = sut.tools().find((d) => d.key === "getPersonTicketStats")!;
  return (input, scope = "all") => def.run(input, makeCtx(scope));
}

describe("WorkspaceCopilotTools.getPersonTicketStats", () => {
  it("exclusively calls countTicketsByProjectAndStatus with no raw DB fallback, ensuring soft-delete filtering is enforced by the service", async () => {
    const wq = makeWorkQuery({
      byProject: [{ projectId: 10, projectName: "Alpha", total: 3, done: 1, inProgress: 1 }],
      totals: { total: 3, done: 1, inProgress: 1 },
    });
    const run = statsToolRun(makeSut(wq));

    const result = await run({ userId: "user-target" });

    expect(wq.countTicketsByProjectAndStatus).toHaveBeenCalledWith(
      CALLER,
      expect.objectContaining({ assigneeId: "user-target" }),
    );
    expect(result).toMatchObject({ kind: "data", data: { totals: { total: 3, done: 1, inProgress: 1 } } });
  });

  it("returns the project breakdown from countTicketsByProjectAndStatus, which enforces project-membership scoping, without adding any extra rows", async () => {
    const wq = makeWorkQuery({
      byProject: [{ projectId: 10, projectName: "Alpha", total: 2, done: 1, inProgress: 1 }],
      totals: { total: 2, done: 1, inProgress: 1 },
    });
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

  it("denies an own-scoped actor querying a different user, rather than reporting a breakage", async () => {
    const wq = makeWorkQuery({ byProject: [], totals: { total: 0, done: 0, inProgress: 0 } });
    const run = statsToolRun(makeSut(wq));

    const result = await run({ userId: "user-other" }, "own");

    expect(result).toMatchObject({ kind: "denied" });
    expect(wq.countTicketsByProjectAndStatus).not.toHaveBeenCalled();
  });

  it("returns an exact total without a partial flag, because GROUP BY returns all project-status groups at once", async () => {
    const wq = makeWorkQuery({
      byProject: [{ projectId: 10, projectName: "Alpha", total: 250, done: 50, inProgress: 100 }],
      totals: { total: 250, done: 50, inProgress: 100 },
    });
    const run = statsToolRun(makeSut(wq));

    const result = await run({ userId: "user-target" }) as {
      kind: "data";
      data: { totals: { total: number }; partial?: boolean };
    };

    expect(result.kind).toBe("data");
    expect(result.data.totals.total).toBe(250);
    expect(result.data.partial).toBeUndefined();
  });
});
