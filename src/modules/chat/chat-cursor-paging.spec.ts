import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import type { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import { ChatMessageTimelineService } from "./chat-message-timeline.service";

/**
 * The property a scrolled list must hold: page through it and every row that
 * existed when you started comes back exactly once, even while rows arrive above
 * you. Offset fails that property, and the last test here shows it failing on the
 * same data, which is the argument for the cursor.
 *
 * These drive the real `ChatMessagesService.list` — the double reads the cursor
 * out of the predicate the service actually compiled, and asserts the predicate
 * has the shape it is reading, so a change to the WHERE breaks the test loudly
 * rather than silently making it meaningless.
 */

const dialect = new PgDialect();
const CHANNEL_ID = 7;
const ACTOR: EntityActor = { userId: "user-1", orgId: "org-1", membershipId: 1, isOrgOwner: false };

interface StoredMessage {
  id: number;
  channelId: number;
  channelPosition: number;
  createdAt: Date;
  content: string;
  metadata: Record<string, unknown> | null;
  /** `with: { reactions }` is part of the message read now; a `many` relation is always an array. */
  reactions: [];
}

class MessageStore {
  readonly rows: StoredMessage[] = [];
  private nextId = 1;

  constructor(count: number, sharedTimestamp?: Date) {
    for (let i = 0; i < count; i++) this.insert(sharedTimestamp);
  }

  insert(at?: Date): StoredMessage {
    const id = this.nextId++;
    const row: StoredMessage = {
      id,
      channelId: CHANNEL_ID,
      channelPosition: id,
      createdAt: at ?? new Date(Date.UTC(2024, 0, 1, 0, 0, id)),
      content: `m${id}`,
      metadata: null,
      reactions: [],
    };
    this.rows.push(row);
    return row;
  }

  /** Newest first, strictly below `cursor` when one is given. */
  newestFirst(cursor: number | undefined, limit: number): StoredMessage[] {
    return this.rows
      .filter((r) => (cursor === undefined ? true : r.channelPosition < cursor))
      .sort((a, b) => b.channelPosition - a.channelPosition)
      .slice(0, limit);
  }

  /** The offset equivalent of the same read, for the comparison at the end. */
  byOffset(page: number, limit: number): StoredMessage[] {
    return this.rows
      .slice()
      .sort((a, b) => b.id - a.id)
      .slice((page - 1) * limit, page * limit);
  }
}

function cursorFromPredicate(where: SQL): number | undefined {
  const { sql: text, params } = dialect.sqlToQuery(where);
  if (!/"chat_messages"\."org_id"\s*=\s*\$/i.test(text))
    throw new Error(`read is not tenant-bound: ${text}`);
  if (!/"chat_messages"\."channel_id"\s*=\s*\$/i.test(text))
    throw new Error(`read is not channel-bound: ${text}`);
  const bound = /"chat_messages"\."channel_position"\s*<\s*\$(\d+)/i.exec(text);
  if (!bound) return undefined;
  const value = params[Number(bound[1]) - 1];
  if (typeof value !== "number") throw new Error(`cursor parameter was ${typeof value}: ${text}`);
  return value;
}

interface Harness {
  readonly service: ChatMessageTimelineService;
  readonly store: MessageStore;
  readonly onRead: (fn: () => void) => void;
}

function buildHarness(store: MessageStore): Harness {
  let afterRead: (() => void) | undefined;

  const selectChain = {
    from: () => selectChain,
    innerJoin: () => selectChain,
    leftJoin: () => selectChain,
    where: () => Promise.resolve([]),
  };

  const db = {
    select: jest.fn().mockReturnValue(selectChain),
    query: {
      chatChannels: { findFirst: jest.fn().mockResolvedValue({ id: CHANNEL_ID }) },
      chatChannelMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
      chatMessages: {
        findMany: jest.fn().mockImplementation(({ where, limit }: { where: SQL; limit: number }) => {
          const rows = store.newestFirst(cursorFromPredicate(where), limit);
          if (afterRead) afterRead();
          return Promise.resolve(rows);
        }),
      },
    },
  } as unknown as Db;

  const entities = {
    withResolvedReferences: jest.fn().mockImplementation(<T>(_actor: EntityActor, rows: T[]) => Promise.resolve(rows)),
  } as unknown as EntityReferenceService;

  const service = new ChatMessageTimelineService(db, entities);

  return {
    service,
    store,
    onRead: (fn) => {
      afterRead = fn;
    },
  };
}

async function pageThrough(
  harness: Harness,
  limit: number,
): Promise<{ ids: number[]; pages: number }> {
  const ids: number[] = [];
  let cursor: number | undefined;
  let pages = 0;

  for (;;) {
    const result = await harness.service.list(CHANNEL_ID, ACTOR, cursor, limit);
    pages++;
    ids.push(...result.messages.map((m) => m.id));
    if (result.nextCursor == null) break;
    cursor = result.nextCursor;
    if (pages > 50) throw new Error("paging did not terminate");
  }

  return { ids, pages };
}

function duplicates(ids: readonly number[]): number[] {
  const seen = new Set<number>();
  const repeated = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated].sort((a, b) => a - b);
}

describe("chat message paging — every row exactly once", () => {
  it("walks a list whose length is not a multiple of the page size", async () => {
    const harness = buildHarness(new MessageStore(23));

    const { ids } = await pageThrough(harness, 10);

    expect(duplicates(ids)).toEqual([]);
    expect([...ids].sort((a, b) => a - b)).toEqual(harness.store.rows.map((r) => r.id));
  });

  it("returns the sentinel row on the next page rather than skipping it", async () => {
    const limit = 10;
    const harness = buildHarness(new MessageStore(limit + 1));

    const first = await harness.service.list(CHANNEL_ID, ACTOR, undefined, limit);
    expect(first.messages).toHaveLength(limit);
    expect(first.nextCursor).toBe(Math.min(...first.messages.map((m) => m.channelPosition)));

    const second = await harness.service.list(CHANNEL_ID, ACTOR, first.nextCursor ?? undefined, limit);
    expect(second.messages).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const ids = [...first.messages, ...second.messages].map((m) => m.id);
    expect(duplicates(ids)).toEqual([]);
    expect([...ids].sort((a, b) => a - b)).toEqual(harness.store.rows.map((r) => r.id));
  });

  it("stops without a cursor when exactly one page remains", async () => {
    const harness = buildHarness(new MessageStore(10));

    const { ids, pages } = await pageThrough(harness, 10);

    expect(pages).toBe(1);
    expect(ids).toHaveLength(10);
  });

  it("returns an empty page for an empty channel", async () => {
    const harness = buildHarness(new MessageStore(0));

    const result = await harness.service.list(CHANNEL_ID, ACTOR, undefined, 10);

    expect(result.messages).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("pages correctly when every row shares a timestamp", async () => {
    const tied = new Date("2024-03-01T09:00:00.000Z");
    const harness = buildHarness(new MessageStore(25, tied));

    const { ids } = await pageThrough(harness, 10);

    expect(harness.store.rows.every((r) => r.createdAt.getTime() === tied.getTime())).toBe(true);
    expect(duplicates(ids)).toEqual([]);
    expect([...ids].sort((a, b) => a - b)).toEqual(harness.store.rows.map((r) => r.id));
  });

  it("shows every original row exactly once while rows arrive above the cursor", async () => {
    const harness = buildHarness(new MessageStore(30));
    const original = harness.store.rows.map((r) => r.id);
    harness.onRead(() => {
      harness.store.insert();
      harness.store.insert();
    });

    const { ids } = await pageThrough(harness, 10);

    expect(duplicates(ids)).toEqual([]);
    for (const id of original) expect(ids).toContain(id);
  });

  it("treats a cursor past the newest row as the first page", async () => {
    const harness = buildHarness(new MessageStore(5));

    const result = await harness.service.list(CHANNEL_ID, ACTOR, 999_999, 10);

    expect(result.messages.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("chat message paging — what offset does on the same data", () => {
  it("repeats rows the cursor does not, once rows arrive above the reader", () => {
    const store = new MessageStore(30);
    const original = store.rows.map((r) => r.id);
    const limit = 10;

    const seen: number[] = [];
    for (let page = 1; page <= 3; page++) {
      const rows = store.byOffset(page, limit);
      seen.push(...rows.map((r) => r.id));
      store.insert();
      store.insert();
    }

    expect(duplicates(seen).length).toBeGreaterThan(0);
    const missed = original.filter((id) => !seen.includes(id));
    expect(missed.length).toBeGreaterThan(0);
  });

  it("does not repeat when nothing is written during the walk", () => {
    const store = new MessageStore(30);
    const seen: number[] = [];
    for (let page = 1; page <= 3; page++) seen.push(...store.byOffset(page, 10).map((r) => r.id));

    expect(duplicates(seen)).toEqual([]);
  });
});
