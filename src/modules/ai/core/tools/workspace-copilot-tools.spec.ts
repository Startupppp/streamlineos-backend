import "reflect-metadata";

jest.mock("../../../directory/person-seam", () => ({
  resolvePeopleByName: jest.fn(),
}));

import { WorkspaceCopilotTools } from "./workspace-copilot-tools";
import type { AskOsActor } from "../services/ask-os-actor";
import type { AskOsToolDefinition, AskOsToolRunContext } from "../registry/ask-os-tool.types";
import { ScopedRead } from "../../../access/scoped-read";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { ProjectsWorkQueryService } from "../../../build/core/projects-work-query.service";
import { resolvePeopleByName, type PersonNameResolution } from "../../../directory/person-seam";

const resolveNames = jest.mocked(resolvePeopleByName);

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

function toolNamed(sut: WorkspaceCopilotTools, key: string): AskOsToolDefinition {
  const def = sut.tools().find((d) => d.key === key);
  if (!def) throw new Error(`Ask OS tool "${key}" is not registered by WorkspaceCopilotTools`);
  return def;
}

function statsToolRun(
  sut: WorkspaceCopilotTools,
): (input: { userId: string; projectId?: number }, scope?: "all" | "own") => Promise<unknown> {
  const def = toolNamed(sut, "getPersonTicketStats");
  return (input, scope = "all") => def.run(input, makeCtx(scope));
}

function findPersonRun(resolution?: PersonNameResolution) {
  const wq = makeWorkQuery({ byProject: [], totals: { total: 0, done: 0, inProgress: 0 } });
  const def = toolNamed(makeSut(wq), "findPerson");
  return (name: string) => {
    const map = new Map<string, PersonNameResolution>();
    if (resolution !== undefined) map.set(name.trim(), resolution);
    resolveNames.mockResolvedValue(map);
    return def.run({ name }, makeCtx());
  };
}

describe("WorkspaceCopilotTools.findPerson", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("resolves a person in an org that never used HR, because the seam drives from organization_members and only left-joins organization_people", async () => {
    const run = findPersonRun({ status: "resolved", userId: "u-priya", displayName: "Priya Sharma" });

    const outcome = await run("Priya");

    expect(outcome).toMatchObject({
      kind: "data",
      data: { results: [{ id: "u-priya", name: "Priya Sharma" }] },
    });
  });

  it("routes the lookup through resolvePeopleByName with the actor's org, so the member and soft-delete filters live in one place", async () => {
    const run = findPersonRun({ status: "resolved", userId: "u-priya", displayName: "Priya Sharma" });

    await run("  Priya  ");

    expect(resolveNames).toHaveBeenCalledWith(expect.anything(), "org-1", ["Priya"]);
  });

  it("reports ambiguity with the seam's candidates instead of returning a list the model would pick from arbitrarily", async () => {
    const run = findPersonRun({
      status: "ambiguous",
      candidates: [
        { label: "Bob Smith", hint: "bob1@example.com" },
        { label: "Bob Jones", hint: "bob2@example.com" },
      ],
    });

    const outcome = await run("Bob");

    expect(outcome).toMatchObject({ kind: "ambiguous" });
    if (outcome.kind !== "ambiguous") throw new Error("expected an ambiguous outcome");
    expect(outcome.candidates.map((candidate) => candidate.label)).toEqual(["Bob Smith", "Bob Jones"]);
  });

  it("returns empty when the seam resolves nobody, so the model cannot invent a user id for getPersonTicketStats", async () => {
    const run = findPersonRun({ status: "unresolved" });

    const outcome = await run("Nobody Known");

    expect(outcome).toMatchObject({ kind: "empty", subject: "people" });
  });

  it("returns empty for a whitespace-only name rather than the arbitrary members a wildcard ILIKE used to return", async () => {
    const run = findPersonRun();

    const outcome = await run("   ");

    expect(outcome).toMatchObject({ kind: "empty", subject: "people" });
  });

  it("falls back to the searched name when the seam resolves a member holding no display or legal name", async () => {
    const run = findPersonRun({ status: "resolved", userId: "u-anon" });

    const outcome = await run("Casey");

    expect(outcome).toMatchObject({
      kind: "data",
      data: { results: [{ id: "u-anon", name: "Casey" }] },
    });
  });
});

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
