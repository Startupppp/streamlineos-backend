import { PgDialect } from "drizzle-orm/pg-core";
import { ProjectsWorkQueryService } from "./projects-work-query.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { AllWorkQuery } from "../dto/projects.schemas";

const ACTOR: CurrentUserContext = {
  orgId: "org-1",
  userId: "user-7",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: { kind: "human-session", membershipId: 42, isOrgOwner: false },
};

function minimalQuery(scope: AllWorkQuery["scope"]): AllWorkQuery {
  return {
    scope,
    cursor: undefined,
    limit: 20,
    orderBy: "rank",
    orderDir: undefined,
    search: undefined,
    status: undefined,
    priority: undefined,
    type: undefined,
    assigneeId: undefined,
    labelIds: undefined,
    cycleId: undefined,
    epicId: undefined,
    dueDateFrom: undefined,
    dueDateTo: undefined,
    projectIds: undefined,
    excludeStatus: undefined,
  };
}

function makeChain(result: unknown[]) {
  const p = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => p,
    then: (onfulfilled: unknown, onrejected: unknown) =>
      p.then(onfulfilled as never, onrejected as never),
    catch: (onrejected: unknown) => p.catch(onrejected as never),
    [Symbol.toStringTag]: "MockChain",
  };
  return chain;
}

function buildMockService() {
  const selectMock = jest.fn().mockReturnValue(makeChain([]));
  const executeMock = jest.fn().mockResolvedValue([]);
  const mockDb = { select: selectMock, execute: executeMock };
  return { service: new ProjectsWorkQueryService(mockDb as never), selectMock };
}

describe("GET /build/all-work — created and subscribed scopes bypass the project-membership gate so a user's own tickets are never hidden", () => {
  it("scope=created with zero project_members rows reaches the ticket query rather than returning the membership short-circuit", async () => {
    const { service, selectMock } = buildMockService();
    await service.getAllWork(ACTOR, minimalQuery("created"));
    expect(selectMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("scope=subscribed with zero project_members rows reaches the ticket query rather than returning the membership short-circuit", async () => {
    const { service, selectMock } = buildMockService();
    await service.getAllWork(ACTOR, minimalQuery("subscribed"));
    expect(selectMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("scope=all applies the project-reachability predicate so the bypass is strictly limited to identity-scoped queries — result is empty and reachability SQL is present", async () => {
    const capturedWhere = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
    });
    const rowChain = {
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnValue({
            leftJoin: jest.fn().mockReturnValue({ where: capturedWhere }),
          }),
        }),
      }),
    };
    const countChain = {
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ total: "0" }]),
        }),
      }),
    };
    const selectMock = jest.fn()
      .mockReturnValueOnce(rowChain)
      .mockReturnValueOnce(countChain);
    const mockDb = { select: selectMock, execute: jest.fn().mockResolvedValue([]) };
    const service = new ProjectsWorkQueryService(mockDb as never);
    const result = await service.getAllWork(ACTOR, minimalQuery("all"));

    expect(result.data).toHaveLength(0);
    const dialect = new PgDialect();
    const rendered = dialect.sqlToQuery(capturedWhere.mock.calls[0]?.[0]);
    expect(rendered.sql.toLowerCase()).toContain("project_members");
    expect(rendered.params).toContain(42);
  });
});
