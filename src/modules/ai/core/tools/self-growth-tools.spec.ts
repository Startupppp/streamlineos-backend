import "reflect-metadata";
import { z } from "zod";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { SelfGrowthTools } from "./self-growth-tools";
import type { AskOsToolRunContext, AskOsToolDefinition } from "../registry/ask-os-tool.types";
import { ScopedRead } from "../../../access/scoped-read";
import type { AskOsActor } from "../services/ask-os-actor";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { Db } from "../../../../db/drizzle.module";

const ACTOR: AskOsActor = {
  userId: "user-growth-01",
  orgId: "org-growth-01",
  membershipId: 42,
  displayName: "Test User",
  email: "test@example.com",
  orgName: "Test Org",
  role: "MEMBER",
  isOrgOwner: false,
  timezone: "UTC",
  today: "2026-09-20",
  monthStart: "2026-09-01",
  monthEnd: "2026-09-30",
  currentYear: 2026,
  currentMonth: 9,
};

const CALLER: CurrentUserContext = {
  userId: "user-growth-01",
  orgId: "org-growth-01",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-01",
  tokenScopes: null,
  principal: humanSessionPrincipal(42, false),
};

function buildCtx(actorOverrides: Partial<AskOsActor> = {}): AskOsToolRunContext {
  const actor = { ...ACTOR, ...actorOverrides };
  const read = ScopedRead.of(actor.orgId, actor.userId, "own");
  return {
    actor,
    caller: CALLER,
    read,
    readFor: () => read,
    modules: {},
  };
}

function renderSql(condition: SQL): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(condition);
}

const SUBJECT_KEYS = new Set([
  "userId",
  "actorId",
  "createdById",
  "authorId",
  "subjectId",
  "memberId",
  "personId",
  "employeeId",
  "targetUserId",
]);

function assertNoSubjectIdentifier(shape: z.ZodRawShape): void {
  for (const key of Object.keys(shape)) {
    if (SUBJECT_KEYS.has(key))
      throw new Error(`Tool input must not accept a subject identifier but found "${key}"`);
  }
}

type WhereCaptor = { where: (c: SQL) => unknown; orderBy: () => unknown; limit: (n: number) => unknown };

function buildCapturingChain(
  captors: { capturedWhere?: SQL; capturedLimit?: number },
  result: unknown[] = [],
): unknown {
  const chain: WhereCaptor = {
    where: (condition: SQL) => {
      captors.capturedWhere = condition;
      return {
        orderBy: () => ({
          limit: (n: number) => {
            captors.capturedLimit = n;
            return Promise.resolve(result);
          },
        }),
      };
    },
    orderBy: () => ({}),
    limit: () => Promise.resolve(result),
  };
  return chain;
}

function buildDb(selectChain: unknown = null): Db {
  const chain = selectChain ?? {
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  };
  return {
    query: {},
    select: jest.fn().mockReturnValue(chain),
  } as unknown as Db;
}

function findTool(tools: AskOsToolDefinition[], key: string): AskOsToolDefinition {
  const tool = tools.find((t) => t.key === key);
  if (!tool) throw new Error(`Tool "${key}" not found`);
  return tool;
}

describe("SelfGrowthTools — no tool accepts a subject identifier in its input schema", () => {
  it("every tool's inputSchema.shape contains no user/subject key — subject comes from ctx.actor only", () => {
    const sut = new SelfGrowthTools(buildDb());
    for (const tool of sut.tools()) {
      const schema = tool.input as z.ZodObject<z.ZodRawShape>;
      assertNoSubjectIdentifier(schema.shape);
    }
  });
});

describe("SelfGrowthTools — tool registration", () => {
  it("registers getMyOnboardingTasks under the expected key with permission self:onboarding-tasks", () => {
    const sut = new SelfGrowthTools(buildDb());
    const tool = findTool(sut.tools(), "getMyOnboardingTasks");
    expect(tool.key).toBe("getMyOnboardingTasks");
    expect(tool.permission).toBe("self:onboarding-tasks");
  });

  it("registers getMyDisciplinaryCases under the expected key with permission self:cases", () => {
    const sut = new SelfGrowthTools(buildDb());
    const tool = findTool(sut.tools(), "getMyDisciplinaryCases");
    expect(tool.key).toBe("getMyDisciplinaryCases");
    expect(tool.permission).toBe("self:cases");
  });

  it("registers getMyGoals under the expected key with no permission — universal self-service read", () => {
    const sut = new SelfGrowthTools(buildDb());
    const tool = findTool(sut.tools(), "getMyGoals");
    expect(tool.key).toBe("getMyGoals");
    expect(tool.permission).toBeUndefined();
  });

  it("registers getMyReviews under the expected key with no permission — universal self-service read", () => {
    const sut = new SelfGrowthTools(buildDb());
    const tool = findTool(sut.tools(), "getMyReviews");
    expect(tool.key).toBe("getMyReviews");
    expect(tool.permission).toBeUndefined();
  });

  it("registers getMyHelpdeskItems under the expected key with no permission — hr:helpdesk:view is not in role defaults", () => {
    const sut = new SelfGrowthTools(buildDb());
    const tool = findTool(sut.tools(), "getMyHelpdeskItems");
    expect(tool.key).toBe("getMyHelpdeskItems");
    expect(tool.permission).toBeUndefined();
  });
});

describe("getMyOnboardingTasks — org-scoped and bounded", () => {
  it("binds the query to ctx.actor.orgId and ctx.actor.userId — both appear as SQL parameters", async () => {
    expect.hasAssertions();
    const captors: { capturedWhere?: SQL; capturedLimit?: number } = {};
    const chain = { from: () => buildCapturingChain(captors) };
    const db = buildDb(chain);
    const sut = new SelfGrowthTools(db);
    await findTool(sut.tools(), "getMyOnboardingTasks").run(
      {},
      buildCtx({ userId: "task-user-abc", orgId: "task-org-abc" }),
    );
    expect(captors.capturedWhere).toBeDefined();
    const { params } = renderSql(captors.capturedWhere!);
    expect(params).toContain("task-org-abc");
    expect(params).toContain("task-user-abc");
  });

  it("read is bounded at 50 rows or fewer", async () => {
    expect.hasAssertions();
    const captors: { capturedWhere?: SQL; capturedLimit?: number } = {};
    const chain = { from: () => buildCapturingChain(captors) };
    const db = buildDb(chain);
    const sut = new SelfGrowthTools(db);
    await findTool(sut.tools(), "getMyOnboardingTasks").run({}, buildCtx());
    expect(captors.capturedLimit).toBeDefined();
    expect(captors.capturedLimit!).toBeLessThanOrEqual(50);
  });

  it("returns empty outcome when no tasks exist — not a failure", async () => {
    expect.hasAssertions();
    const captors: { capturedWhere?: SQL; capturedLimit?: number } = {};
    const chain = { from: () => buildCapturingChain(captors, []) };
    const db = buildDb(chain);
    const sut = new SelfGrowthTools(db);
    const outcome = await findTool(sut.tools(), "getMyOnboardingTasks").run({}, buildCtx());
    expect(outcome.kind).toBe("empty");
  });
});

describe("getMyDisciplinaryCases — org-scoped, self-only, and bounded", () => {
  it("binds the query to ctx.actor.orgId and ctx.actor.userId as subjectEmployeeId — both appear as SQL parameters", async () => {
    expect.hasAssertions();
    const captors: { capturedWhere?: SQL; capturedLimit?: number } = {};
    const chain = { from: () => buildCapturingChain(captors) };
    const db = buildDb(chain);
    const sut = new SelfGrowthTools(db);
    await findTool(sut.tools(), "getMyDisciplinaryCases").run(
      {},
      buildCtx({ userId: "case-user-xyz", orgId: "case-org-xyz" }),
    );
    expect(captors.capturedWhere).toBeDefined();
    const { params } = renderSql(captors.capturedWhere!);
    expect(params).toContain("case-org-xyz");
    expect(params).toContain("case-user-xyz");
  });

  it("read is bounded at 20 rows or fewer — disciplinary data is sensitive", async () => {
    expect.hasAssertions();
    const captors: { capturedWhere?: SQL; capturedLimit?: number } = {};
    const chain = { from: () => buildCapturingChain(captors) };
    const db = buildDb(chain);
    const sut = new SelfGrowthTools(db);
    await findTool(sut.tools(), "getMyDisciplinaryCases").run({}, buildCtx());
    expect(captors.capturedLimit).toBeDefined();
    expect(captors.capturedLimit!).toBeLessThanOrEqual(20);
  });
});

describe("getMyGoals — org-scoped and bounded", () => {
  it("binds the query to ctx.actor.orgId and ctx.actor.userId — both appear as SQL parameters", async () => {
    expect.hasAssertions();
    const captors: { capturedWhere?: SQL; capturedLimit?: number } = {};
    const chain = { from: () => buildCapturingChain(captors) };
    const db = buildDb(chain);
    const sut = new SelfGrowthTools(db);
    await findTool(sut.tools(), "getMyGoals").run(
      {},
      buildCtx({ userId: "goal-user-123", orgId: "goal-org-123" }),
    );
    expect(captors.capturedWhere).toBeDefined();
    const { params } = renderSql(captors.capturedWhere!);
    expect(params).toContain("goal-org-123");
    expect(params).toContain("goal-user-123");
  });

  it("read is bounded at 50 rows or fewer", async () => {
    expect.hasAssertions();
    const captors: { capturedWhere?: SQL; capturedLimit?: number } = {};
    const chain = { from: () => buildCapturingChain(captors) };
    const db = buildDb(chain);
    const sut = new SelfGrowthTools(db);
    await findTool(sut.tools(), "getMyGoals").run({}, buildCtx());
    expect(captors.capturedLimit).toBeDefined();
    expect(captors.capturedLimit!).toBeLessThanOrEqual(50);
  });
});

describe("getMyReviews — org-scoped and bounded", () => {
  it("binds the query to ctx.actor.orgId and ctx.actor.userId — both appear as SQL parameters", async () => {
    expect.hasAssertions();
    const captors: { capturedWhere?: SQL; capturedLimit?: number } = {};
    const chain = { from: () => buildCapturingChain(captors) };
    const db = buildDb(chain);
    const sut = new SelfGrowthTools(db);
    await findTool(sut.tools(), "getMyReviews").run(
      {},
      buildCtx({ userId: "review-user-456", orgId: "review-org-456" }),
    );
    expect(captors.capturedWhere).toBeDefined();
    const { params } = renderSql(captors.capturedWhere!);
    expect(params).toContain("review-org-456");
    expect(params).toContain("review-user-456");
  });

  it("read is bounded at 20 rows or fewer", async () => {
    expect.hasAssertions();
    const captors: { capturedWhere?: SQL; capturedLimit?: number } = {};
    const chain = { from: () => buildCapturingChain(captors) };
    const db = buildDb(chain);
    const sut = new SelfGrowthTools(db);
    await findTool(sut.tools(), "getMyReviews").run({}, buildCtx());
    expect(captors.capturedLimit).toBeDefined();
    expect(captors.capturedLimit!).toBeLessThanOrEqual(20);
  });
});

describe("getMyHelpdeskItems — org-scoped and bounded", () => {
  it("binds the query to ctx.actor.orgId and ctx.actor.userId — both appear as SQL parameters", async () => {
    expect.hasAssertions();
    const captors: { capturedWhere?: SQL; capturedLimit?: number } = {};
    const chain = { from: () => buildCapturingChain(captors) };
    const db = buildDb(chain);
    const sut = new SelfGrowthTools(db);
    await findTool(sut.tools(), "getMyHelpdeskItems").run(
      {},
      buildCtx({ userId: "hd-user-789", orgId: "hd-org-789" }),
    );
    expect(captors.capturedWhere).toBeDefined();
    const { params } = renderSql(captors.capturedWhere!);
    expect(params).toContain("hd-org-789");
    expect(params).toContain("hd-user-789");
  });

  it("read is bounded at 30 rows or fewer", async () => {
    expect.hasAssertions();
    const captors: { capturedWhere?: SQL; capturedLimit?: number } = {};
    const chain = { from: () => buildCapturingChain(captors) };
    const db = buildDb(chain);
    const sut = new SelfGrowthTools(db);
    await findTool(sut.tools(), "getMyHelpdeskItems").run({}, buildCtx());
    expect(captors.capturedLimit).toBeDefined();
    expect(captors.capturedLimit!).toBeLessThanOrEqual(30);
  });
});
