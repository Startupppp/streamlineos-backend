import { PgDialect } from "drizzle-orm/pg-core";
import { ProjectsWorkQueryService } from "./projects-work-query.service";
import type { AccessService } from "../../../access/access.service";
import { MEMBER_STANDING, principalAccess } from "../project-crud/__tests__/project-access-doubles";

const memberAccess = () => principalAccess(MEMBER_STANDING) as unknown as AccessService;
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { AllWorkQuery } from "../dto/projects.schemas";

const ORG_ID = "org-union-test";

const ACTOR: CurrentUserContext = {
  orgId: ORG_ID,
  userId: "user-7",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: { kind: "human-session", membershipId: 42, isOrgOwner: false },
};

function makeQuery(overrides: Partial<AllWorkQuery> = {}): AllWorkQuery {
  return {
    scope: "all",
    cursor: undefined,
    limit: 20,
    orderBy: "created",
    orderDir: undefined,
    search: undefined,
    status: undefined,
    priority: undefined,
    type: undefined,
    assigneeId: ["__unassigned__", "user-abc"],
    labelIds: undefined,
    cycleId: undefined,
    epicId: undefined,
    dueDateFrom: undefined,
    dueDateTo: undefined,
    projectIds: undefined,
    excludeStatus: undefined,
    ...overrides,
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

function paramOccurrencesInHalf(sqlHalf: string, params: unknown[], value: unknown): number {
  const matches = [...sqlHalf.matchAll(/\$(\d+)/g)];
  return matches.filter((m) => params[Number(m[1]) - 1] === value).length;
}

describe("getAllWork assignee UNION — independently indexable branches (BE-81)", () => {
  const dialect = new PgDialect();
  let capturedExecute: jest.Mock;
  let renderedUnionSql: { sql: string; params: unknown[] };

  beforeEach(async () => {
    capturedExecute = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: "0" }]);

    const db = {
      select: jest.fn().mockReturnValue(makeChain([])),
      execute: capturedExecute,
    } as unknown as Db;

    const svc = new ProjectsWorkQueryService(db, memberAccess());
    await svc.getAllWork(ACTOR, makeQuery());

    renderedUnionSql = dialect.sqlToQuery(capturedExecute.mock.calls[0]?.[0]);
  });

  it("phase-1 execute emits UNION ALL between two branches, not an OR, so both assignee predicates are independently indexable", () => {
    expect(renderedUnionSql.sql).toContain("UNION ALL");
    expect(renderedUnionSql.sql.split("UNION ALL").length).toBe(2);
  });

  it("org_id bound appears in both UNION branches so neither branch can escape the tenant fence (org bound in every branch)", () => {
    const halves = renderedUnionSql.sql.split("UNION ALL");
    expect(halves.length).toBe(2);
    expect(paramOccurrencesInHalf(halves[0], renderedUnionSql.params, ORG_ID)).toBeGreaterThanOrEqual(2);
    expect(paramOccurrencesInHalf(halves[1], renderedUnionSql.params, ORG_ID)).toBeGreaterThanOrEqual(2);
  });
});

describe("getAllWork assignee UNION — shared-createdAt tiebreak pagination", () => {
  const sharedAt = "2026-01-15T10:00:00.000000";

  const baseRow = {
    title: "T",
    status: "TODO",
    priority: "MEDIUM",
    type: "TASK",
    dueDate: null,
    startDate: null,
    ticketNumber: 1,
    points: null,
    estimate: null,
    rank: null,
    version: 1,
    createdAt: new Date(sharedAt),
    updatedAt: new Date(sharedAt),
    assigneeId: null,
    assigneeName: null,
    assigneeFirstName: null,
    assigneeLastName: null,
    assigneeEmail: null,
    assigneeImage: null,
    cycleId: null,
    epicId: null,
    projectId: 10,
    projectKey: "PROJ",
    projectName: "Test",
    cursorCreatedAt: sharedAt,
    cursorUpdatedAt: sharedAt,
  };

  it("rows sharing createdAt page across the boundary without skipping or duplicating when the id tiebreak is the only discriminator (shared-createdAt tiebreak pagination)", async () => {
    const rowHighId = { ...baseRow, id: 20 };
    const rowLowId = { ...baseRow, id: 10, ticketNumber: 2 };

    const execute1 = jest
      .fn()
      .mockResolvedValueOnce([{ id: 20 }, { id: 10 }])
      .mockResolvedValueOnce([{ total: "2" }]);
    const select1 = jest
      .fn()
      .mockReturnValueOnce(makeChain([rowHighId]))
      .mockReturnValueOnce(makeChain([]));

    const db1 = { select: select1, execute: execute1 } as unknown as Db;
    const svc1 = new ProjectsWorkQueryService(db1, memberAccess());
    const page1 = await svc1.getAllWork(ACTOR, makeQuery({ limit: 1 }));

    expect(page1.data.map((r) => r.id)).toEqual([20]);
    expect(page1.hasMore).toBe(true);
    const cursor1 = page1.nextCursor;
    expect(cursor1).toBeTruthy();

    const execute2 = jest.fn().mockResolvedValueOnce([{ id: 10 }]);
    const select2 = jest
      .fn()
      .mockReturnValueOnce(makeChain([rowLowId]))
      .mockReturnValueOnce(makeChain([]));

    const db2 = { select: select2, execute: execute2 } as unknown as Db;
    const svc2 = new ProjectsWorkQueryService(db2, memberAccess());
    const page2 = await svc2.getAllWork(ACTOR, makeQuery({ limit: 1, cursor: cursor1! }));

    expect(page2.data.map((r) => r.id)).toEqual([10]);

    const allIds = [...page1.data.map((r) => r.id), ...page2.data.map((r) => r.id)];
    expect(new Set(allIds).size).toBe(allIds.length);

    const dialect = new PgDialect();
    const page1UnionSql = dialect.sqlToQuery(execute1.mock.calls[0]?.[0]);
    expect(page1UnionSql.sql).toMatch(/ORDER BY 2 (ASC|DESC), 1 (ASC|DESC)/);

    const page2UnionSql = dialect.sqlToQuery(execute2.mock.calls[0]?.[0]);
    expect(page2UnionSql.params).toContain(20);
  });
});

describe("getAllWork scope=mine assignee UNION — no OR between the null check and the semi-join (BE-81)", () => {
  const dialect = new PgDialect();
  let idSql: { sql: string; params: unknown[] };
  let countSql: { sql: string; params: unknown[] };

  beforeEach(async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: "0" }]);
    const db = {
      select: jest.fn().mockReturnValue(makeChain([])),
      execute,
    } as unknown as Db;

    const svc = new ProjectsWorkQueryService(db, memberAccess());
    await svc.getAllWork(ACTOR, makeQuery({ scope: "mine" }));

    idSql = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    countSql = dialect.sqlToQuery(execute.mock.calls[1]?.[0]);
  });

  it("emits no OR joining the unassigned test to the membership IN list, because an OR defeats both indexes", () => {
    expect(idSql.sql).not.toMatch(/assignee_membership_id"? is null\s+or\b/i);
    expect(countSql.sql).not.toMatch(
      /assignee_membership_id"? is null\s+or\b/i,
    );
  });

  it("crosses the two mine branches with the two assignee branches into four independently indexable UNION branches", () => {
    expect(idSql.sql.split(" UNION ").length).toBe(4);
    expect(countSql.sql.split(" UNION ").length).toBe(4);
  });

  it("keeps the unassigned test and the membership IN list on separate branches so each can use idx_tickets_org_assignee_status", () => {
    const branches = idSql.sql.split(" UNION ");
    const nullBranches = branches.filter((b) =>
      /assignee_membership_id"? is null/i.test(b),
    );
    const inBranches = branches.filter((b) =>
      /assignee_membership_id"? in \(select id from organization_members where org_id = \$\d+ and user_id in/i.test(
        b,
      ),
    );
    expect(nullBranches.length).toBe(2);
    expect(inBranches.length).toBe(2);
    expect(
      branches.filter(
        (b) =>
          /assignee_membership_id"? is null/i.test(b) &&
          /user_id in/i.test(b),
      ).length,
    ).toBe(0);
  });

  it("binds the acting user on every branch, so no branch widens past the caller's own work", () => {
    const branches = idSql.sql.split(" UNION ");
    for (const branch of branches) {
      expect(branch).toContain("user_id = $");
    }
  });
});
