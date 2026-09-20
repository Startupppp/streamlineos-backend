import "reflect-metadata";
import { z } from "zod";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { SelfCommsTools } from "./self-comms-tools";
import type { AskOsToolRunContext, AskOsToolDefinition } from "../registry/ask-os-tool.types";
import { ScopedRead } from "../../../access/scoped-read";
import type { AskOsActor } from "../services/ask-os-actor";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { Db } from "../../../../db/drizzle.module";

const ACTOR: AskOsActor = {
  userId: "user-comms-01",
  orgId: "org-comms-01",
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
  userId: "user-comms-01",
  orgId: "org-comms-01",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-comms-01",
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

function buildDb(overrides: Record<string, unknown> = {}): Db {
  return {
    query: {
      notifications: { findMany: jest.fn().mockResolvedValue([]) },
    },
    select: jest.fn().mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    }),
    ...overrides,
  } as unknown as Db;
}

function findTool(tools: AskOsToolDefinition[], key: string): AskOsToolDefinition {
  const tool = tools.find((t) => t.key === key);
  if (!tool) throw new Error(`Tool "${key}" not found`);
  return tool;
}

describe("SelfCommsTools — no tool accepts a subject identifier in its input schema", () => {
  it("every tool's inputSchema.shape contains no user/subject key", () => {
    const sut = new SelfCommsTools(buildDb());
    for (const tool of sut.tools()) {
      const schema = tool.input as z.ZodObject<z.ZodRawShape>;
      assertNoSubjectIdentifier(schema.shape);
    }
  });
});

describe("getMyInbox — tool registration", () => {
  it("is registered in tools() with key 'getMyInbox'", () => {
    const sut = new SelfCommsTools(buildDb());
    expect(findTool(sut.tools(), "getMyInbox")).toBeDefined();
  });

  it("carries no permission field — universal self-service surface", () => {
    const sut = new SelfCommsTools(buildDb());
    expect(findTool(sut.tools(), "getMyInbox").permission).toBeUndefined();
  });
});

describe("getMyInbox — org-scoped and bounded read", () => {
  it("binds the query to ctx.actor.orgId and ctx.actor.membershipId — both appear as SQL parameters", async () => {
    expect.hasAssertions();
    let capturedOpts: { where?: SQL } | undefined;
    const db = buildDb({
      query: {
        notifications: {
          findMany: jest.fn().mockImplementation((opts: { where?: SQL }) => {
            capturedOpts = opts;
            return Promise.resolve([]);
          }),
        },
      },
    });

    const sut = new SelfCommsTools(db);
    await findTool(sut.tools(), "getMyInbox").run(
      {},
      buildCtx({ orgId: "org-inbox-scope", membershipId: 77 }),
    );

    expect(capturedOpts?.where).toBeDefined();
    const { params } = renderSql(capturedOpts!.where!);
    expect(params).toContain("org-inbox-scope");
    expect(params).toContain(77);
  });

  it("applies a hard row limit — the read is bounded", async () => {
    expect.hasAssertions();
    let capturedLimit: number | undefined;
    const db = buildDb({
      query: {
        notifications: {
          findMany: jest.fn().mockImplementation((opts: { limit?: number }) => {
            capturedLimit = opts.limit;
            return Promise.resolve([]);
          }),
        },
      },
    });

    const sut = new SelfCommsTools(db);
    await findTool(sut.tools(), "getMyInbox").run({}, buildCtx());

    expect(capturedLimit).toBeGreaterThan(0);
  });
});

describe("getMyNotificationCount — tool registration", () => {
  it("is registered in tools() with key 'getMyNotificationCount'", () => {
    const sut = new SelfCommsTools(buildDb());
    expect(findTool(sut.tools(), "getMyNotificationCount")).toBeDefined();
  });

  it("carries no permission field — universal self-service surface", () => {
    const sut = new SelfCommsTools(buildDb());
    expect(findTool(sut.tools(), "getMyNotificationCount").permission).toBeUndefined();
  });
});

describe("getMyNotificationCount — org-scoped unread count", () => {
  it("binds the count query to ctx.actor.orgId and ctx.actor.membershipId — both appear as SQL parameters", async () => {
    expect.hasAssertions();
    let capturedWhere: SQL | undefined;
    const db = {
      query: buildDb().query,
      select: jest.fn().mockReturnValue({
        from: () => ({
          where: (condition: SQL) => {
            capturedWhere = condition;
            return Promise.resolve([{ unreadCount: 3 }]);
          },
        }),
      }),
    } as unknown as Db;

    const sut = new SelfCommsTools(db);
    await findTool(sut.tools(), "getMyNotificationCount").run(
      {},
      buildCtx({ orgId: "org-count-scope", membershipId: 55 }),
    );

    expect(capturedWhere).toBeDefined();
    const { params } = renderSql(capturedWhere!);
    expect(params).toContain("org-count-scope");
    expect(params).toContain(55);
  });

  it("returns a data outcome containing unreadCount", async () => {
    expect.hasAssertions();
    const db = {
      query: buildDb().query,
      select: jest.fn().mockReturnValue({
        from: () => ({
          where: () => Promise.resolve([{ unreadCount: 7 }]),
        }),
      }),
    } as unknown as Db;

    const sut = new SelfCommsTools(db);
    const outcome = await findTool(sut.tools(), "getMyNotificationCount").run({}, buildCtx());

    expect(outcome.kind).toBe("data");
    if (outcome.kind === "data") {
      expect(typeof (outcome.data as { unreadCount: number }).unreadCount).toBe("number");
    }
  });
});

describe("getMyAnnouncements — tool registration", () => {
  it("is registered in tools() with key 'getMyAnnouncements'", () => {
    const sut = new SelfCommsTools(buildDb());
    expect(findTool(sut.tools(), "getMyAnnouncements")).toBeDefined();
  });

  it("carries no permission field — universal self-service surface", () => {
    const sut = new SelfCommsTools(buildDb());
    expect(findTool(sut.tools(), "getMyAnnouncements").permission).toBeUndefined();
  });
});

describe("getMyAnnouncements — org-scoped and bounded read", () => {
  it("binds the query to ctx.actor.orgId — orgId appears as a SQL parameter", async () => {
    expect.hasAssertions();
    let capturedWhere: SQL | undefined;

    type AnnChain = {
      where: (c: SQL) => AnnChain;
      orderBy: (...args: unknown[]) => AnnChain;
      limit: (n: number) => Promise<unknown[]>;
    };
    const fromChain: AnnChain = {
      where: (condition: SQL) => {
        capturedWhere = condition;
        return fromChain;
      },
      orderBy: () => fromChain,
      limit: () => Promise.resolve([]),
    };

    const db = {
      query: buildDb().query,
      select: jest.fn().mockReturnValue({ from: () => fromChain }),
    } as unknown as Db;

    const sut = new SelfCommsTools(db);
    await findTool(sut.tools(), "getMyAnnouncements").run(
      {},
      buildCtx({ orgId: "org-ann-scope" }),
    );

    expect(capturedWhere).toBeDefined();
    const { params } = renderSql(capturedWhere!);
    expect(params).toContain("org-ann-scope");
  });

  it("applies a hard row limit — the read is bounded", async () => {
    expect.hasAssertions();
    let capturedLimit: number | undefined;

    type AnnChain = {
      where: () => AnnChain;
      orderBy: (...args: unknown[]) => AnnChain;
      limit: (n: number) => Promise<unknown[]>;
    };
    const fromChain: AnnChain = {
      where: () => fromChain,
      orderBy: () => fromChain,
      limit: (n: number) => {
        capturedLimit = n;
        return Promise.resolve([]);
      },
    };

    const db = {
      query: buildDb().query,
      select: jest.fn().mockReturnValue({ from: () => fromChain }),
    } as unknown as Db;

    const sut = new SelfCommsTools(db);
    await findTool(sut.tools(), "getMyAnnouncements").run({}, buildCtx());

    expect(capturedLimit).toBeGreaterThan(0);
  });
});
