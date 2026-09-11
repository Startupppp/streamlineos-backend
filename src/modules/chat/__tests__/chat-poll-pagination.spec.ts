import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import { ChatMessageTimelineService } from "../chat-message-timeline.service";

/**
 * Forward-pagination contract for poll:
 * - Every row returned by the initial `since` call and each cursor page comes
 *   back exactly once — no duplicates, no skips.
 * - `hasMore` is true whenever the page was truncated; a client that sees it
 *   knows it must fetch the next page rather than treating the batch as complete.
 * - The read is scoped to (orgId, channelId) and excludes deleted messages.
 */

const dialect = new PgDialect();
const CHANNEL_ID = 99;
const ORG_ID = "org-poll-test";
const ACTOR: EntityActor = {
  userId: "user-poll",
  orgId: ORG_ID,
  membershipId: 7,
  isOrgOwner: false,
} as unknown as EntityActor;

interface StoredMessage {
  id: number;
  channelId: number;
  orgId: string;
  channelPosition: number;
  createdAt: Date;
  content: string;
  isDeleted: boolean;
  metadata: Record<string, unknown> | null;
  senderMembership: null;
  replyTo: null;
  /** `with: { reactions }` is part of the read now; a `many` relation is always an array. */
  reactions: [];
  attachments: [];
}

class PollMessageStore {
  readonly rows: StoredMessage[] = [];
  private nextPos = 1;

  insert(opts?: { isDeleted?: boolean; orgId?: string }): StoredMessage {
    const pos = this.nextPos++;
    const row: StoredMessage = {
      id: pos,
      channelId: CHANNEL_ID,
      orgId: opts?.orgId ?? ORG_ID,
      channelPosition: pos,
      createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, pos)),
      content: `msg-${pos}`,
      isDeleted: opts?.isDeleted ?? false,
      metadata: null,
      senderMembership: null,
      replyTo: null,
      reactions: [],
      attachments: [],
    };
    this.rows.push(row);
    return row;
  }

  insertMany(n: number): void {
    for (let i = 0; i < n; i++) this.insert();
  }

  newerThanCursor(cursor: number | undefined, since: Date | undefined, limit: number): StoredMessage[] {
    return this.rows
      .filter((r) => {
        if (r.isDeleted) return false;
        if (r.orgId !== ORG_ID) return false;
        if (r.channelId !== CHANNEL_ID) return false;
        if (cursor !== undefined) return r.channelPosition > cursor;
        if (since !== undefined) return r.createdAt > since;
        return true;
      })
      .sort((a, b) => a.channelPosition - b.channelPosition)
      .slice(0, limit);
  }
}

function extractPollPredicate(where: SQL): { cursor: number | undefined; isDeletedFiltered: boolean; isTenantBound: boolean; isChannelBound: boolean } {
  const { sql: text, params } = dialect.sqlToQuery(where);
  const isTenantBound = /"chat_messages"\."org_id"\s*=\s*\$/i.test(text);
  const isChannelBound = /"chat_messages"\."channel_id"\s*=\s*\$/i.test(text);
  const isDeletedFiltered = /"chat_messages"\."is_deleted"\s*=\s*\$/i.test(text);
  const bound = /"chat_messages"\."channel_position"\s*>\s*\$(\d+)/i.exec(text);
  if (!bound) return { cursor: undefined, isDeletedFiltered, isTenantBound, isChannelBound };
  const value = params[Number(bound[1]) - 1];
  if (typeof value !== "number") throw new Error(`cursor param was ${typeof value}: ${text}`);
  return { cursor: value, isDeletedFiltered, isTenantBound, isChannelBound };
}

function buildPollHarness(store: PollMessageStore): ChatMessageTimelineService {
  const db = {
    query: {
      chatChannels: { findFirst: jest.fn().mockResolvedValue({ id: CHANNEL_ID, type: "PUBLIC" }) },
      chatChannelMembers: { findFirst: jest.fn().mockResolvedValue({ id: ACTOR.membershipId }) },
      chatMessages: {
        findMany: jest.fn().mockImplementation(({ where, limit }: { where: SQL; limit: number }) => {
          const pred = extractPollPredicate(where);
          if (!pred.isTenantBound) throw new Error("query is not tenant-bound");
          if (!pred.isChannelBound) throw new Error("query is not channel-bound");
          return Promise.resolve(store.newerThanCursor(pred.cursor, undefined, limit));
        }),
      },
    },
  } as unknown as Db;

  const entities = {
    withResolvedReferences: jest.fn().mockImplementation(<T>(_actor: EntityActor, rows: T[]) => Promise.resolve(rows)),
  } as unknown as EntityReferenceService;

  return new ChatMessageTimelineService(db, entities);
}

function duplicates(ids: number[]): number[] {
  const seen = new Set<number>();
  const repeated = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated].sort((a, b) => a - b);
}

async function drainPoll(
  service: ChatMessageTimelineService,
  since: Date,
  limit: number,
): Promise<{ ids: number[]; pages: number; sawHasMore: boolean }> {
  const ids: number[] = [];
  let cursor: number | undefined;
  let pages = 0;
  let sawHasMore = false;

  for (;;) {
    const result = await service.poll(CHANNEL_ID, ACTOR, since, cursor, limit);
    pages++;
    ids.push(...result.messages.map((m) => m.id));
    if (result.hasMore) sawHasMore = true;
    if (result.nextCursor == null) break;
    cursor = result.nextCursor;
    if (pages > 100) throw new Error("poll pagination did not terminate");
  }

  return { ids, pages, sawHasMore };
}

describe("chat poll — forward cursor pagination", () => {
  const EPOCH = new Date(0);

  it("returns hasMore=true and a nextCursor when more than one page of messages exist", async () => {
    const store = new PollMessageStore();
    store.insertMany(25);
    const service = buildPollHarness(store);

    const first = await service.poll(CHANNEL_ID, ACTOR, EPOCH, undefined, 10);

    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(first.messages).toHaveLength(10);
  });

  it("returns hasMore=false and nextCursor=null on the last page", async () => {
    const store = new PollMessageStore();
    store.insertMany(5);
    const service = buildPollHarness(store);

    const result = await service.poll(CHANNEL_ID, ACTOR, EPOCH, undefined, 10);

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.messages).toHaveLength(5);
  });

  it("cursor walk covers all rows with no duplicates and no skips", async () => {
    const store = new PollMessageStore();
    store.insertMany(47);
    const service = buildPollHarness(store);

    const { ids, sawHasMore } = await drainPoll(service, EPOCH, 10);

    expect(sawHasMore).toBe(true);
    expect(duplicates(ids)).toEqual([]);
    expect([...ids].sort((a, b) => a - b)).toEqual(
      store.rows.filter((r) => !r.isDeleted).map((r) => r.id),
    );
  });

  it("excludes deleted messages from every page", async () => {
    const store = new PollMessageStore();
    store.insertMany(5);
    store.insert({ isDeleted: true });
    store.insert({ isDeleted: true });
    store.insertMany(5);
    const service = buildPollHarness(store);

    const { ids } = await drainPoll(service, EPOCH, 50);

    const deletedIds = store.rows.filter((r) => r.isDeleted).map((r) => r.id);
    for (const deletedId of deletedIds) expect(ids).not.toContain(deletedId);
    expect(ids).toHaveLength(10);
  });

  it("query is always tenant-scoped to (orgId, channelId)", async () => {
    const store = new PollMessageStore();
    store.insertMany(3);
    const predicateSpy = jest.fn().mockImplementation(({ where, limit }: { where: SQL; limit: number }) => {
      const pred = extractPollPredicate(where);
      if (!pred.isTenantBound) throw new Error("not tenant-bound");
      if (!pred.isChannelBound) throw new Error("not channel-bound");
      if (!pred.isDeletedFiltered) throw new Error("deleted messages not excluded");
      return Promise.resolve(store.newerThanCursor(pred.cursor, undefined, limit));
    });

    const db = {
      query: {
        chatChannels: { findFirst: jest.fn().mockResolvedValue({ id: CHANNEL_ID, type: "PUBLIC" }) },
        chatChannelMembers: { findFirst: jest.fn().mockResolvedValue({ id: ACTOR.membershipId }) },
        chatMessages: { findMany: predicateSpy },
      },
    } as unknown as Db;
    const entities = {
      withResolvedReferences: jest.fn().mockImplementation(<T>(_actor: EntityActor, rows: T[]) => Promise.resolve(rows)),
    } as unknown as EntityReferenceService;
    const service = new ChatMessageTimelineService(db, entities);

    await service.poll(CHANNEL_ID, ACTOR, EPOCH, undefined, 10);

    expect(predicateSpy).toHaveBeenCalledTimes(1);
  });

  it("pages with limit=1 to prove cursor strictly advances — no duplicates", async () => {
    const store = new PollMessageStore();
    store.insertMany(5);
    const service = buildPollHarness(store);

    const { ids } = await drainPoll(service, EPOCH, 1);

    expect(duplicates(ids)).toEqual([]);
    expect(ids).toHaveLength(5);
  });
});
