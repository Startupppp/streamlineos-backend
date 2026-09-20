import "reflect-metadata";
import { z } from "zod";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { SelfDigestTools } from "./self-digest-tools";
import type { AskOsToolDefinition, AskOsToolRunContext } from "../registry/ask-os-tool.types";
import { ScopedRead } from "../../../access/scoped-read";
import type { AskOsActor } from "../services/ask-os-actor";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { Db } from "../../../../db/drizzle.module";
import type { ProjectsWorkQueryService } from "../../../build/core/projects-work-query.service";
import type { KbDocumentQueryService } from "../../../kb/document-query/kb-document-query.service";

const ACTOR: AskOsActor = {
  userId: "user-digest-01",
  orgId: "org-digest-01",
  membershipId: 7,
  displayName: "Digest User",
  email: "digest@example.com",
  orgName: "Digest Org",
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
  userId: "user-digest-01",
  orgId: "org-digest-01",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-digest-01",
  tokenScopes: null,
  principal: humanSessionPrincipal(7, false),
};

function makeCtx(actorOverrides: Partial<AskOsActor> = {}): AskOsToolRunContext {
  const actor = { ...ACTOR, ...actorOverrides };
  const read = ScopedRead.of(actor.orgId, actor.userId, "own");
  return { actor, caller: CALLER, read, readFor: () => read, modules: {} };
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
      throw new Error(
        `Tool input must not accept a subject identifier but found "${key}"`,
      );
  }
}

type AllWorkResult = Awaited<ReturnType<ProjectsWorkQueryService["getAllWork"]>>;

function emptyWork(): AllWorkResult {
  return { data: [], limit: 10, nextCursor: null, hasMore: false, total: 0 };
}

function makeSelectChain(resolvedValue: unknown[] = []): unknown {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.innerJoin = () => chain;
  chain.leftJoin = () => chain;
  chain.where = () => chain;
  chain.orderBy = () => chain;
  chain.limit = () => Promise.resolve(resolvedValue);
  chain.then = (
    resolve: (v: unknown) => unknown,
    reject: (e: unknown) => unknown,
  ) => Promise.resolve(resolvedValue).then(resolve, reject);
  return chain;
}

function makeDb(overrides: Record<string, unknown> = {}): Db {
  return {
    query: {
      attendance: { findMany: jest.fn().mockResolvedValue([]) },
    },
    select: jest.fn().mockReturnValue(makeSelectChain()),
    ...overrides,
  } as unknown as Db;
}

function makeWorkQuery(result: AllWorkResult = emptyWork()): ProjectsWorkQueryService {
  return { getAllWork: jest.fn().mockResolvedValue(result) } as unknown as ProjectsWorkQueryService;
}

function makeKbDocumentQuery(hits: unknown[] = []): KbDocumentQueryService {
  return { searchDocuments: jest.fn().mockResolvedValue(hits) } as unknown as KbDocumentQueryService;
}

function findTool(tools: AskOsToolDefinition[], key: string): AskOsToolDefinition {
  const found = tools.find((t) => t.key === key);
  if (!found) throw new Error(`Tool "${key}" not found`);
  return found;
}

describe("SelfDigestTools — tool registration", () => {
  it("registers summarizeMyDay and searchMyDocuments under the correct keys", () => {
    const sut = new SelfDigestTools(makeWorkQuery(), makeDb(), makeKbDocumentQuery());
    const keys = sut.tools().map((t) => t.key);
    expect(keys).toContain("summarizeMyDay");
    expect(keys).toContain("searchMyDocuments");
  });
});

describe("SelfDigestTools — subject-identifier guard", () => {
  it("neither tool's input schema accepts a userId or other subject identifier — identity comes from ctx.actor only", () => {
    const sut = new SelfDigestTools(makeWorkQuery(), makeDb(), makeKbDocumentQuery());
    for (const tool of sut.tools()) {
      const schema = tool.input as z.ZodObject<z.ZodRawShape>;
      assertNoSubjectIdentifier(schema.shape);
    }
  });
});

describe("summarizeMyDay — concurrency", () => {
  it("all five reads are in flight before any resolves — proving a single Promise.all, not five sequential awaits", async () => {
    expect.hasAssertions();

    let callCount = 0;
    const resolvers: Array<(v: unknown) => void> = [];

    function trackAndDefer(): Promise<unknown> {
      callCount++;
      return new Promise<unknown>((r) => {
        resolvers.push(r);
      });
    }

    function makeDeferredChain(): unknown {
      const deferred = trackAndDefer();
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.leftJoin = () => chain;
      chain.where = () => chain;
      chain.orderBy = () => chain;
      chain.limit = () => deferred;
      chain.then = (
        res: (v: unknown) => unknown,
        rej: (e: unknown) => unknown,
      ) => deferred.then(res, rej);
      return chain;
    }

    const db = {
      query: {
        attendance: {
          findMany: jest.fn(() => {
            callCount++;
            return new Promise<unknown>((r) => {
              resolvers.push(r);
            });
          }),
        },
      },
      select: jest.fn(() => makeDeferredChain()),
    } as unknown as Db;

    const workQuery = {
      getAllWork: jest.fn(() => {
        callCount++;
        return new Promise<unknown>((r) => {
          resolvers.push(r);
        });
      }),
    } as unknown as ProjectsWorkQueryService;

    const sut = new SelfDigestTools(workQuery, db, makeKbDocumentQuery());
    const tool = findTool(sut.tools(), "summarizeMyDay");

    const runPromise = tool.run({}, makeCtx());

    expect(callCount).toBe(5);

    resolvers[0]?.([]);
    resolvers[1]?.([]);
    resolvers[2]?.(emptyWork());
    resolvers[3]?.([]);
    resolvers[4]?.([{ unread: 0 }]);

    await runPromise;
  });
});

describe("summarizeMyDay — timezone correctness", () => {
  it("attendance date filter uses ctx.actor.today — not new Date() — so a caller past UTC midnight still reads the right day", async () => {
    expect.hasAssertions();
    let capturedWhere: SQL | undefined;

    const db = makeDb({
      query: {
        attendance: {
          findMany: jest.fn().mockImplementation((opts: { where?: SQL }) => {
            capturedWhere = opts.where;
            return Promise.resolve([]);
          }),
        },
      },
    });

    const sut = new SelfDigestTools(makeWorkQuery(), db, makeKbDocumentQuery());
    const tool = findTool(sut.tools(), "summarizeMyDay");

    await tool.run({}, makeCtx({ today: "2025-12-31" }));

    expect(capturedWhere).toBeDefined();
    const { params } = renderSql(capturedWhere!);
    expect(params).toContain("2025-12-31");
  });
});

describe("searchMyDocuments — ACL binding", () => {
  it("onboarding document query binds the caller's userId from ctx.actor in the WHERE predicate — never accepts a userId from tool input", async () => {
    expect.hasAssertions();
    let capturedWhere: SQL | undefined;

    const db = {
      query: {
        attendance: { findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn().mockReturnValue({
        from: () => ({
          where: (condition: SQL) => {
            capturedWhere = condition;
            return {
              orderBy: () => ({
                limit: () => Promise.resolve([]),
              }),
            };
          },
        }),
      }),
    } as unknown as Db;

    const sut = new SelfDigestTools(makeWorkQuery(), db, makeKbDocumentQuery());
    const tool = findTool(sut.tools(), "searchMyDocuments");

    await tool.run({ query: "passport", limit: 5 }, makeCtx());

    expect(capturedWhere).toBeDefined();
    const { params } = renderSql(capturedWhere!);
    expect(params).toContain("user-digest-01");
  });

  it("kb document search passes ctx.caller as the user context so the session identity gates what the caller sees — a caller-supplied userId in tool input cannot override it", async () => {
    expect.hasAssertions();

    const kbQuery = makeKbDocumentQuery();
    const searchDocuments = kbQuery.searchDocuments as jest.Mock;

    const sut = new SelfDigestTools(makeWorkQuery(), makeDb(), kbQuery);
    const tool = findTool(sut.tools(), "searchMyDocuments");
    const ctx = makeCtx();

    await tool.run({ query: "onboarding", limit: 5 }, ctx);

    expect(searchDocuments).toHaveBeenCalledTimes(1);
    const [calledUser] = searchDocuments.mock.calls[0] as [unknown, unknown, unknown];
    expect(calledUser).toBe(ctx.caller);
  });
});
