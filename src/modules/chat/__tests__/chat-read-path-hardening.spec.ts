/**
 * The hermetic half of the chat read-path release fixes. No database.
 *
 * Each block below pins one defect that shipped at journal head, and each one is red
 * against the code as it was:
 *
 *   PRIVACY   `GET /chat/search/channels` matched every channel in the org with no
 *             `is_private` or membership arm, so searching a colleague's name enumerated
 *             the DIRECT channels they are in (named `${creator} & ${target}`) and every
 *             PRIVATE channel's name and description reached non-members.
 *   REACTIONS the three message reads carried no `reactions` in their projection, so the
 *             emoji a user had just added vanished on the refetch the reaction mutation
 *             itself triggers, and no reaction survived a page reload.
 *   PAGING    `GET /chat/saved?limit=abc` reached drizzle as `NaN`; the dialect emits
 *             `limit` only for a finite non-negative number, so the clause DISAPPEARED and
 *             the read became unbounded rather than erroring.
 *   UNREAD    `GET /chat/unread` counted every unread message in every channel with no
 *             org predicate and no ceiling.
 *   ARBITER   the new `uniq_chat_channels_org_entity` is PARTIAL, so its ON CONFLICT
 *             target must carry the predicate or the statement is 42P10 at plan time —
 *             the 1054 lesson applied before it can bite.
 *
 * The catalog and plan half is `chat-read-path-hardening.db.spec.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import { chatChannels, chatMessages, chatReplyReminders } from "../../../db/schema";
import { ChatSearchService } from "../chat-search.service";
import { ChatMessageTimelineService } from "../chat-message-timeline.service";
import { ChatSavedService } from "../chat-saved.service";
import { ChatPresenceService } from "../chat-presence.service";
import { CHAT_ENTITY_CHANNEL_CONFLICT } from "../chat-entity-channel-conflict-target";
import { foldReactions } from "../chat-message-reaction-shape";

const dialect = new PgDialect();
const ORG_ID = "org-hardening";
const ACTOR = {
  userId: "user-hardening",
  orgId: ORG_ID,
  membershipId: 7,
  isOrgOwner: false,
} as unknown as EntityActor;

const passThroughEntities = {
  withResolvedReferences: jest
    .fn()
    .mockImplementation(<T>(_actor: EntityActor, rows: T[]) => Promise.resolve(rows)),
  resolve: jest.fn().mockResolvedValue([]),
} as unknown as EntityReferenceService;

function renderWhere(where: SQL | undefined): string {
  if (!where) return "";
  return dialect.sqlToQuery(where).sql;
}

/** Captures the single relational-query argument a service hands the driver. */
function captureQuery() {
  const calls: Array<Record<string, unknown>> = [];
  const capture = jest.fn().mockImplementation((arg: Record<string, unknown>) => {
    calls.push(arg);
    return Promise.resolve([]);
  });
  return { calls, capture };
}

describe("chat search channels — private and DIRECT names are not enumerable", () => {
  async function whereClauseFor(memberChannelIds: number[]): Promise<string> {
    const { calls, capture } = captureQuery();
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest
              .fn()
              .mockResolvedValue(memberChannelIds.map((channelId) => ({ channelId }))),
          }),
        }),
      }),
      query: { chatChannels: { findMany: capture } },
    } as unknown as Db;

    await new ChatSearchService(db, passThroughEntities).searchChannels(ORG_ID, "u", "alice");
    const [call] = calls;
    if (!call) throw new Error("searchChannels never queried chat_channels");
    return renderWhere(call["where"] as SQL);
  }

  it("filters on is_private, which the head form did not", async () => {
    const clause = await whereClauseFor([11, 12]);
    expect(clause).toMatch(/"chat_channels"\."is_private"\s*=\s*\$/);
    expect(clause).toMatch(/"chat_channels"\."id"\s+in\s*\(/i);
    // The head form was org + name only; if the or() were dropped this would hold again.
    expect(clause).toMatch(/\bor\b/i);
  });

  it("a member of nothing sees public channels only, never an unfiltered read", async () => {
    const clause = await whereClauseFor([]);
    // drizzle-orm 0.45.2 renders an empty inArray as the literal `false`, so the arm
    // collapses to `is_private = $n or false` — public only, not a dropped predicate.
    expect(clause).toMatch(/"chat_channels"\."is_private"\s*=\s*\$\d+\s+or\s+false/i);
  });
});

describe("chat message reads — reactions ride the projection", () => {
  function timelineHarness() {
    const { calls, capture } = captureQuery();
    const db = {
      query: {
        chatChannels: { findFirst: jest.fn().mockResolvedValue({ id: 1, type: "PUBLIC" }) },
        chatChannelMembers: { findFirst: jest.fn().mockResolvedValue({ id: 7 }) },
        chatMessages: { findMany: capture, findFirst: jest.fn().mockResolvedValue(null) },
      },
    } as unknown as Db;
    return { calls, service: new ChatMessageTimelineService(db, passThroughEntities) };
  }

  function reactionsProjection(call: Record<string, unknown> | undefined): unknown {
    if (!call) throw new Error("the read never reached chat_messages");
    return (call["with"] as Record<string, unknown> | undefined)?.["reactions"];
  }

  it("list() asks for them", async () => {
    const { calls, service } = timelineHarness();
    await service.list(1, ACTOR, undefined, 50);
    expect(reactionsProjection(calls[0])).toEqual({
      columns: { emoji: true },
      with: { membership: { columns: { userId: true } } },
    });
  });

  it("poll() asks for them", async () => {
    const { calls, service } = timelineHarness();
    await service.poll(1, ACTOR, new Date(0), undefined, 50);
    expect(reactionsProjection(calls[0])).toBeDefined();
  });

  it("the fold produces the same emoji -> userId[] map the mutation returns", () => {
    expect(
      foldReactions([
        { emoji: "👍", membership: { userId: "u1" } },
        { emoji: "👍", membership: { userId: "u2" } },
        { emoji: "🎉", membership: { userId: "u1" } },
        // A reaction whose membership row is gone keeps its emoji and contributes no id.
        { emoji: "🎉", membership: null },
      ]),
    ).toEqual({ "👍": ["u1", "u2"], "🎉": ["u1"] });
  });
});

describe("saved messages — a non-numeric limit cannot reach the query", () => {
  function savedHarness() {
    const { calls, capture } = captureQuery();
    const db = { query: { chatSavedMessages: { findMany: capture } } } as unknown as Db;
    return { calls, service: new ChatSavedService(db, passThroughEntities) };
  }

  it("NaN is clamped to the default rather than passed through", async () => {
    const { calls, service } = savedHarness();
    await service.list(ACTOR, undefined, Number.NaN);
    // The head form computed `Math.min(Math.max(1, NaN), 100) + 1` = NaN, and drizzle
    // emits the `limit` clause only when `typeof limit === "number" && limit >= 0`
    // (pg-core/dialect.js:286) — `NaN >= 0` is false — so the clause vanished and the
    // read returned every saved message the member had.
    expect(calls[0]?.["limit"]).toBe(31);
  });

  it("an over-large limit still clamps to the platform cap", async () => {
    const { calls, service } = savedHarness();
    await service.list(ACTOR, undefined, 5000);
    expect(calls[0]?.["limit"]).toBe(101);
  });

  it("a normal limit is untouched", async () => {
    const { calls, service } = savedHarness();
    await service.list(ACTOR, undefined, 20);
    expect(calls[0]?.["limit"]).toBe(21);
  });
});

describe("unread badge — bounded and org-scoped", () => {
  it("names org_id on BOTH sides of the join and caps the count", async () => {
    const rendered: string[] = [];
    let selectCall = 0;
    const db = {
      query: {
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 7 }) },
      },
      select: jest.fn().mockImplementation(() => {
        selectCall += 1;
        // Call 1 builds the capped subquery and ends at `.as()`; call 2 is the outer
        // `select(count()).from(subquery)`, which resolves.
        if (selectCall > 1) {
          return { from: jest.fn().mockResolvedValue([{ total: 3 }]) };
        }
        const chain: Record<string, unknown> = {};
        chain["from"] = jest.fn().mockReturnValue(chain);
        chain["innerJoin"] = jest.fn().mockImplementation((_table: unknown, on: SQL) => {
          rendered.push(renderWhere(on));
          return chain;
        });
        chain["where"] = jest.fn().mockImplementation((where: SQL) => {
          rendered.push(renderWhere(where));
          return chain;
        });
        chain["limit"] = jest.fn().mockImplementation((n: number) => {
          rendered.push(`LIMIT ${n}`);
          return chain;
        });
        chain["as"] = jest.fn().mockReturnValue({ capped: true });
        return chain;
      }),
    } as unknown as Db;

    const total = await new ChatPresenceService(db).getUnreadTotal("u", ORG_ID);
    const all = rendered.join(" | ");

    // `getUnreadTotal` swallows its own errors and answers 0, so a broken harness would
    // look like a passing assertion on an empty string. Pin the answer first.
    expect(total).toBe(3);
    // The head form joined on channel_id alone and filtered on membership_id alone: no
    // org_id anywhere, which cost the planner the leading column of
    // idx_chat_messages_unread.
    expect(all).toMatch(/"chat_messages"\."org_id"\s*=\s*"chat_channel_members"\."org_id"/);
    expect(all).toMatch(/"chat_channel_members"\."org_id"\s*=\s*\$/);
    // And it had no ceiling at all: a week away made the badge slower without bound.
    expect(all).toContain("LIMIT 100");
  });
});

describe("entity channel conflict target — the arbiter carries its predicate", () => {
  it("emits `on conflict (…) where entity_type is not null`, and a bare target does not", () => {
    const offline = drizzle(postgres("postgres://unused@127.0.0.1:1/unused", { max: 1 }));
    const compile = (config: Parameters<
      ReturnType<ReturnType<typeof offline.insert>["values"]>["onConflictDoNothing"]
    >[0]) =>
      offline
        .insert(chatChannels)
        .values({ orgId: "o", name: "n", type: "GROUP", entityType: "ticket", entityId: "42" })
        .onConflictDoNothing(config)
        .toSQL().sql;

    const shipped = compile(CHAT_ENTITY_CHANNEL_CONFLICT);
    const bare = compile({
      target: [chatChannels.orgId, chatChannels.entityType, chatChannels.entityId],
    });

    expect(bare).toContain(`on conflict ("org_id","entity_type","entity_id") do nothing`);
    expect(shipped).toMatch(
      /on conflict \("org_id","entity_type","entity_id"\) where .*entity_type.* do nothing/,
    );
    expect(shipped).not.toContain(`"entity_id") do nothing`);
  });
});

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "migrations");

function stripSqlComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

type IndexState = { partial: boolean; unique: boolean; createdBy: string } | null;

function replayIndexState(indexName: string): IndexState {
  const journal: { entries: Array<{ when: number; tag: string }> } = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  );
  const ordered = [...journal.entries].sort((a, b) => a.when - b.when);
  const create = new RegExp(
    String.raw`CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?${indexName}"?`,
    "i",
  );
  const drop = new RegExp(
    String.raw`DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?"?${indexName}"?`,
    "i",
  );

  let state: IndexState = null;
  for (const entry of ordered) {
    const raw = readFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
    for (const chunk of raw.split("--> statement-breakpoint")) {
      const statement = stripSqlComments(chunk);
      if (drop.test(statement)) state = null;
      const made = create.exec(statement);
      if (made) {
        state = {
          partial: /\)\s*WHERE\s/i.test(statement),
          unique: Boolean(made[1]),
          createdBy: entry.tag,
        };
      }
    }
  }
  return state;
}

function declaredIndex(
  table: typeof chatMessages | typeof chatChannels | typeof chatReplyReminders,
  name: string,
) {
  const found = getTableConfig(table).indexes.find(
    (index) => (index as unknown as { config: { name: string } }).config.name === name,
  );
  return (found as unknown as { config: { unique?: boolean; where?: unknown } } | undefined)
    ?.config;
}

describe("chat read-path indexes — migration corpus agrees with the declaration", () => {
  it("idx_chat_messages_channel_position is TOTAL in both, which is what lets list() use it", () => {
    expect(declaredIndex(chatMessages, "idx_chat_messages_channel_position")?.where).toBeUndefined();
    expect(replayIndexState("idx_chat_messages_channel_position")).toEqual({
      partial: false,
      unique: false,
      createdBy: "1058_chat_read_path_indexes",
    });
  });

  it("idx_chat_messages_org_reply exists and is partial on reply_to_id", () => {
    const declared = declaredIndex(chatMessages, "idx_chat_messages_org_reply");
    expect(declared).toBeDefined();
    expect(declared?.unique).toBeFalsy();
    expect(declared?.where).toBeDefined();
    expect(replayIndexState("idx_chat_messages_org_reply")).toEqual({
      partial: true,
      unique: false,
      createdBy: "1058_chat_read_path_indexes",
    });
  });

  it("uniq_chat_channels_org_entity is UNIQUE and partial in both", () => {
    const declared = declaredIndex(chatChannels, "uniq_chat_channels_org_entity");
    expect(declared?.unique).toBe(true);
    expect(declared?.where).toBeDefined();
    expect(replayIndexState("uniq_chat_channels_org_entity")).toEqual({
      partial: true,
      unique: true,
      createdBy: "1058_chat_read_path_indexes",
    });
  });

  it("the plain idx_chat_channels_org_entity it replaces is gone from the declaration", () => {
    expect(declaredIndex(chatChannels, "idx_chat_channels_org_entity")).toBeUndefined();
  });

  it("idx_chat_reply_reminders_pending exists and is partial on the pending predicate", () => {
    const declared = declaredIndex(chatReplyReminders, "idx_chat_reply_reminders_pending");
    expect(declared).toBeDefined();
    expect(declared?.where).toBeDefined();
    expect(replayIndexState("idx_chat_reply_reminders_pending")).toEqual({
      partial: true,
      unique: false,
      createdBy: "1060_chat_reply_reminder_pending_index",
    });
    expect(declaredIndex(chatReplyReminders, "idx_chat_reply_reminders_due")).toBeDefined();
  });

  it("the replay can see a partial creation at all — 0980 really created one", () => {
    const state = replayIndexState("uniq_chat_messages_client_key");
    expect(state?.partial).toBe(true);
    expect(state?.unique).toBe(true);
  });
});
