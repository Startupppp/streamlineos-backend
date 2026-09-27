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

  it("scope=all with zero project_members rows still short-circuits so the bypass is strictly limited to identity-scoped queries", async () => {
    const { service, selectMock } = buildMockService();
    const result = await service.getAllWork(ACTOR, minimalQuery("all"));
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(result.data).toHaveLength(0);
  });
});
