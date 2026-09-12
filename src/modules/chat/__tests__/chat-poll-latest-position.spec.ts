import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import { matchesPredicate } from "../../../test/sql-predicate";
import { ChatMessageTimelineService } from "../chat-message-timeline.service";

const CHANNEL_ID = 31;
const ORG_ID = "org-latest-position";
const ACTOR: EntityActor = {
  orgId: ORG_ID,
  userId: "user-latest-position",
  membershipId: 5,
  isOrgOwner: false,
};

interface PollRow {
  id: number;
  orgId: string;
  channelId: number;
  channelPosition: number;
  createdAt: Date;
  isDeleted: boolean;
  metadata: null;
  senderMembership: null;
  replyTo: null;
  reactions: [];
  attachments: [];
}

class Store {
  readonly rows: PollRow[] = [];
  private nextPosition = 1;

  append(at: Date, options?: { isDeleted?: boolean }): PollRow {
    const position = this.nextPosition++;
    const row: PollRow = {
      id: position,
      orgId: ORG_ID,
      channelId: CHANNEL_ID,
      channelPosition: position,
      createdAt: at,
      isDeleted: options?.isDeleted ?? false,
      metadata: null,
      senderMembership: null,
      replyTo: null,
      reactions: [],
      attachments: [],
    };
    this.rows.push(row);
    return row;
  }

  appendMany(count: number, from: Date): void {
    for (let i = 0; i < count; i++)
      this.append(new Date(from.getTime() + i * 1_000));
  }
}

function columnRow(row: PollRow): Record<string, unknown> {
  return {
    org_id: row.orgId,
    channel_id: row.channelId,
    channel_position: row.channelPosition,
    created_at: row.createdAt,
    is_deleted: row.isDeleted,
  };
}

function buildService(store: Store): ChatMessageTimelineService {
  const db = {
    query: {
      chatChannels: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: CHANNEL_ID, type: "PUBLIC", entityType: null, entityId: null }),
      },
      chatChannelMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: ACTOR.membershipId }),
      },
      chatMessages: {
        findMany: jest.fn(({ where, limit }: { where: SQL; limit: number }) =>
          Promise.resolve(
            store.rows
              .filter((row) => matchesPredicate(where, { chat_messages: [columnRow(row)] }))
              .sort((a, b) => a.channelPosition - b.channelPosition)
              .slice(0, limit),
          ),
        ),
      },
    },
  } as unknown as Db;

  const entities = {
    withResolvedReferences: jest.fn(<T,>(_actor: EntityActor, rows: T[]) => Promise.resolve(rows)),
  } as unknown as EntityReferenceService;

  return new ChatMessageTimelineService(db, entities);
}

const EPOCH = new Date("2026-01-01T00:00:00.000Z");
const BEFORE_EPOCH = new Date(EPOCH.getTime() - 1_000);

describe("chat poll — latestPosition is the server-authored resume point", () => {
  it("reports the position of the last returned message on a truncated page", async () => {
    const store = new Store();
    store.appendMany(25, EPOCH);
    const service = buildService(store);

    const page = await service.poll(CHANNEL_ID, ACTOR, BEFORE_EPOCH, undefined, 10);

    expect(page.messages).toHaveLength(10);
    expect(page.hasMore).toBe(true);
    expect(page.latestPosition).toBe(10);
    expect(page.latestPosition).toBe(page.nextCursor);
  });

  it("still reports a position on the FINAL page, where nextCursor is null", async () => {
    const store = new Store();
    store.appendMany(4, EPOCH);
    const service = buildService(store);

    const page = await service.poll(CHANNEL_ID, ACTOR, EPOCH, undefined, 10);

    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.latestPosition).toBe(4);
  });

  it("reports null for an empty page so the client keeps the position it already holds", async () => {
    const store = new Store();
    const service = buildService(store);

    const page = await service.poll(CHANNEL_ID, ACTOR, EPOCH, undefined, 10);

    expect(page.messages).toEqual([]);
    expect(page.latestPosition).toBeNull();
  });

  it("skips a deleted tail row rather than reporting a position the page does not contain", async () => {
    const store = new Store();
    store.appendMany(3, EPOCH);
    store.append(new Date(EPOCH.getTime() + 9_000), { isDeleted: true });
    const service = buildService(store);

    const page = await service.poll(CHANNEL_ID, ACTOR, BEFORE_EPOCH, undefined, 10);

    expect(page.messages.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(page.latestPosition).toBe(3);
  });

  it("drains a multi-page backlog with no duplicates and no skips when the client resumes on latestPosition alone", async () => {
    const store = new Store();
    store.appendMany(47, EPOCH);
    const service = buildService(store);

    const seen: number[] = [];
    let position: number | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const page: Awaited<ReturnType<ChatMessageTimelineService["poll"]>> = await service.poll(
        CHANNEL_ID,
        ACTOR,
        position === null ? BEFORE_EPOCH : undefined,
        position === null ? undefined : position,
        10,
      );
      seen.push(...page.messages.map((m) => m.id));
      if (page.latestPosition !== null) position = page.latestPosition;
      if (!page.hasMore) break;
    }

    expect(seen).toEqual(store.rows.map((row) => row.id));
    expect(new Set(seen).size).toBe(47);
  });

  it("BITE: a message created exactly at `since` is not re-delivered, because since is a resume point", async () => {
    const store = new Store();
    store.appendMany(3, EPOCH);
    const service = buildService(store);

    const page = await service.poll(CHANNEL_ID, ACTOR, EPOCH, undefined, 10);

    expect(page.messages.map((m) => m.id)).toEqual([2, 3]);
    expect(page.latestPosition).toBe(3);
  });

  it("loses nothing across a resume that a client wall-clock 'since' would drop", async () => {
    const store = new Store();
    store.appendMany(3, EPOCH);
    const service = buildService(store);

    const first = await service.poll(CHANNEL_ID, ACTOR, EPOCH, undefined, 10);
    expect(first.latestPosition).toBe(3);

    const clientClockAfterFirstPoll = new Date(EPOCH.getTime() + 60_000);
    store.append(new Date(EPOCH.getTime() + 30_000));

    const bySkewedClock = await service.poll(
      CHANNEL_ID,
      ACTOR,
      clientClockAfterFirstPoll,
      undefined,
      10,
    );
    expect(bySkewedClock.messages).toEqual([]);

    const byPosition = await service.poll(CHANNEL_ID, ACTOR, undefined, first.latestPosition ?? undefined, 10);
    expect(byPosition.messages.map((m) => m.id)).toEqual([4]);
    expect(byPosition.latestPosition).toBe(4);
  });
});
