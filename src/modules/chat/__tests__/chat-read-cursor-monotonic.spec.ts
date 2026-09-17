import { PgDialect } from "drizzle-orm/pg-core";
import { SQL, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import { ChatChannelMemberState } from "../chat-channel-member-state";
import { ChatChannelListService } from "../chat-channel-list.service";
import { ChatPresenceService } from "../chat-presence.service";

/**
 * Two marks in flight commit in either order. With a plain assignment the older cursor can
 * land last and rewind it, so already-read messages come back unread; GREATEST makes the
 * advance monotonic regardless of commit order.
 *
 * The cursor itself is `channel_position`, not `created_at`. `created_at` is `DEFAULT now()`
 * — transaction start — and `TenantContextInterceptor` holds one transaction per request,
 * while `ChatMessagesService.send` serializes on the channel row lock. So a send that queues
 * on that lock commits AFTER a mark-read while carrying a timestamp from BEFORE it, and a
 * timestamp comparison counts it as already read, permanently. `channel_position` is
 * allocated under the same lock, so it is monotone in commit order (migration 1074).
 */
const dialect = new PgDialect();

const ORG = "org-a";
const USER = "user-a";
const CHANNEL_ID = 42;
const MEMBERSHIP = 11;

function render(value: unknown): { sql: string; params: unknown[] } {
  if (!(value instanceof SQL))
    throw new Error(`expected a drizzle SQL expression, got ${typeof value}`);
  const rendered = dialect.sqlToQuery(value);
  return { sql: rendered.sql, params: rendered.params };
}

function harness() {
  const setCalls: Array<Record<string, unknown>> = [];
  const whereCalls: unknown[] = [];
  const db = {
    query: {
      chatChannels: { findFirst: jest.fn().mockResolvedValue({ id: CHANNEL_ID, isPrivate: false }) },
      chatChannelMembers: { findFirst: jest.fn().mockResolvedValue({ role: "MEMBER" }) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: MEMBERSHIP }) },
    },
    update: jest.fn(() => ({
      set: jest.fn((values: Record<string, unknown>) => {
        setCalls.push(values);
        return {
          where: jest.fn((condition: unknown) => {
            whereCalls.push(condition);
            return Promise.resolve(undefined);
          }),
        };
      }),
    })),
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  };
  const state = new ChatChannelMemberState(db as unknown as Db);
  return { state, setCalls, whereCalls };
}

const CHAIN_METHODS = new Set([
  "from",
  "where",
  "innerJoin",
  "leftJoin",
  "rightJoin",
  "fullJoin",
  "innerJoinLateral",
  "leftJoinLateral",
  "orderBy",
  "groupBy",
  "having",
  "limit",
  "offset",
  "as",
]);

const NOT_A_COLUMN = new Set([
  "then",
  "toString",
  "valueOf",
  "constructor",
  "toJSON",
  "inspect",
  "$$typeof",
]);

/**
 * A query-builder recorder. It answers every awaited chain from a queue and keeps the real
 * condition objects the service handed to `.where()` / `.innerJoin()`, so the predicates
 * asserted below are the production ones rendered by `PgDialect` — nothing here rebuilds a
 * predicate the test then checks against itself. Unknown property reads answer with a SQL
 * placeholder so a subquery alias (`ranked.memberRank`, `latestMessage.content`) composes
 * instead of throwing before the query under test is reached.
 */
function queryRecorder(results: unknown[][]) {
  const conditions: SQL[] = [];
  const queue = [...results];
  const methods = new Map<string, (...args: unknown[]) => unknown>();
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key === "symbol") return undefined;
        if (key === "then")
          return (resolve: (value: unknown[]) => unknown) => resolve(queue.shift() ?? []);
        if (NOT_A_COLUMN.has(key)) return undefined;
        const cached = methods.get(key);
        if (cached) return cached;
        if (!CHAIN_METHODS.has(key)) return sql`1`;
        const fn = (...args: unknown[]) => {
          for (const arg of args) if (arg instanceof SQL) conditions.push(arg);
          return proxy;
        };
        methods.set(key, fn);
        return fn;
      },
    },
  );
  return { conditions, select: jest.fn(() => proxy) };
}

function renderedConditions(conditions: SQL[]): string[] {
  return conditions.map((condition) => render(condition).sql);
}

describe("chat read cursor advances monotonically", () => {
  it("markRead writes GREATEST(last_read_at, <now>) rather than assigning", async () => {
    const { state, setCalls } = harness();

    await state.markRead(CHANNEL_ID, USER, ORG);

    expect(setCalls).toHaveLength(1);
    const rendered = render(setCalls[0]?.["lastReadAt"]);
    expect(rendered.sql).toContain("GREATEST");
    expect(rendered.sql).toContain("last_read_at");
    // The timestamp crosses as a bound ISO string with an explicit cast: a JS Date
    // interpolated into a raw sql template reaches postgres.js as a Date and throws.
    expect(rendered.sql).toContain("::timestamp");
    expect(rendered.params).toHaveLength(1);
    expect(typeof rendered.params[0]).toBe("string");
    expect(String(rendered.params[0])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("markRead advances last_read_position with GREATEST in the database", async () => {
    const { state, setCalls } = harness();

    await state.markRead(CHANNEL_ID, USER, ORG);

    const rendered = render(setCalls[0]?.["lastReadPosition"]);
    expect(rendered.sql).toMatch(/GREATEST\("chat_channel_members"\."last_read_position"/);
    expect(rendered.sql).not.toContain("last_read_at");
  });

  it("markRead derives the target position from the channel counter, never from the caller", async () => {
    const { state, setCalls } = harness();

    await state.markRead(CHANNEL_ID, USER, ORG);

    const rendered = render(setCalls[0]?.["lastReadPosition"]);
    expect(rendered.sql).toContain('"chat_channels"."message_count"');
    expect(rendered.params).toEqual([CHANNEL_ID, ORG]);
  });

  it("markRead scopes the write to org, channel and the caller's own membership", async () => {
    const { state, whereCalls } = harness();

    await state.markRead(CHANNEL_ID, USER, ORG);

    expect(whereCalls).toHaveLength(1);
    const rendered = render(whereCalls[0]);
    expect(rendered.sql).toContain('"chat_channel_members"."org_id"');
    expect(rendered.sql).toContain('"chat_channel_members"."channel_id"');
    expect(rendered.sql).toContain('"chat_channel_members"."membership_id"');
    expect(rendered.params).toEqual([ORG, CHANNEL_ID, MEMBERSHIP]);
  });

  it("markChannelUnread deliberately moves both cursors back, so neither may be guarded", async () => {
    const { state, setCalls } = harness();

    await state.markChannelUnread(CHANNEL_ID, USER, ORG);

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]?.["lastReadAt"]).toBeInstanceOf(Date);
    expect(setCalls[0]?.["lastReadPosition"]).toBe(0);
  });
});

describe("the unread count compares positions, not timestamps", () => {
  it("the badge total joins on channel_position > last_read_position", async () => {
    const { conditions, select } = queryRecorder([[{ total: 0 }]]);
    const db = {
      query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: MEMBERSHIP }) } },
      select,
    };
    const service = new ChatPresenceService(db as unknown as Db, {
      resolve: jest.fn().mockResolvedValue([]),
    } as unknown as EntityReferenceService);

    await service.getUnreadTotal(USER, ORG);

    const rendered = renderedConditions(conditions);
    const unread = rendered.filter((text) => text.includes("channel_position"));
    expect(unread).toHaveLength(1);
    expect(unread[0]).toContain('"chat_messages"."channel_position"');
    expect(unread[0]).toContain('"chat_channel_members"."last_read_position"');
    expect(rendered.join("\n")).not.toContain("last_read_at");
  });

  it("the sidebar per-channel count joins on channel_position > last_read_position", async () => {
    const { conditions, select } = queryRecorder([[{ id: 7, lastMessageAt: new Date() }]]);
    const db = {
      query: {
        chatChannels: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 7,
              name: "General",
              type: "GROUP",
              avatarUrl: null,
              isArchived: false,
              entityType: null,
              entityId: null,
            },
          ]),
        },
      },
      select,
    };
    const entities = { resolve: jest.fn().mockResolvedValue([]) };
    const service = new ChatChannelListService(
      db as unknown as Db,
      entities as unknown as EntityReferenceService,
    );
    const actor: EntityActor = {
      orgId: ORG,
      userId: USER,
      membershipId: MEMBERSHIP,
      isOrgOwner: false,
    };

    await service.getMyChannels(actor).catch(() => undefined);

    const rendered = renderedConditions(conditions);
    const unread = rendered.filter((text) => text.includes("channel_position"));
    expect(unread).toHaveLength(1);
    expect(unread[0]).toContain('"chat_messages"."channel_position"');
    expect(unread[0]).toContain('"chat_channel_members"."last_read_position"');
    expect(rendered.join("\n")).not.toContain("last_read_at");
  });
});
