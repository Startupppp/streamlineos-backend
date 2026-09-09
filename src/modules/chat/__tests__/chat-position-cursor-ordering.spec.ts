import { Test } from "@nestjs/testing";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import { ChatMessageTimelineService } from "../chat-message-timeline.service";

const dialect = new PgDialect();
const CHANNEL_ID = 7;
const ACTOR: EntityActor = {
  orgId: "org-ordering",
  userId: "user-1",
  membershipId: 3,
  isOrgOwner: false,
};
const EPOCH = new Date(0);
const SHUFFLED_IDS = [
  907, 902, 918, 905, 911, 901, 923, 909, 914, 903, 920, 906, 916, 912, 904,
  921, 908, 919, 913, 910, 922, 915, 917,
];

interface StoredMessage {
  id: number;
  orgId: string;
  channelId: number;
  channelPosition: number;
  createdAt: Date;
  content: string;
  isDeleted: boolean;
  metadata: Record<string, unknown> | null;
  senderMembership: null;
  replyTo: null;
  reactions: [];
  attachments: [];
}

interface ReadPlan {
  readonly text: string;
  readonly orderBy: string;
  readonly sortColumn: string;
  readonly descending: boolean;
  readonly below: number | undefined;
  readonly above: number | undefined;
  readonly since: Date | undefined;
  readonly excludesDeleted: boolean;
}

const SORT_KEYS: Record<string, (row: StoredMessage) => number> = {
  channel_position: (row) => row.channelPosition,
  id: (row) => row.id,
  created_at: (row) => row.createdAt.getTime(),
};

function positionBound(
  text: string,
  params: readonly unknown[],
  operator: "<" | ">",
): number | undefined {
  const match = new RegExp(
    `"chat_messages"\\."channel_position"\\s*${operator}\\s*\\$(\\d+)`,
    "i",
  ).exec(text);
  if (!match) return undefined;
  const value = params[Number(match[1]) - 1];
  if (typeof value !== "number") throw new Error(`cursor param was ${typeof value}: ${text}`);
  return value;
}

function sinceBound(text: string, params: readonly unknown[]): Date | undefined {
  const match = /"chat_messages"\."created_at"\s*>\s*\$(\d+)/i.exec(text);
  if (!match) return undefined;
  const value = params[Number(match[1]) - 1];
  if (typeof value !== "string") throw new Error(`since param was ${typeof value}: ${text}`);
  return new Date(value);
}

function readPlan(where: SQL, orderBy: readonly SQL[]): ReadPlan {
  const { sql: text, params } = dialect.sqlToQuery(where);
  if (!/"chat_messages"\."org_id"\s*=\s*\$/i.test(text))
    throw new Error(`read is not tenant-bound: ${text}`);
  if (!/"chat_messages"\."channel_id"\s*=\s*\$/i.test(text))
    throw new Error(`read is not channel-bound: ${text}`);
  const rendered = orderBy.map((clause) => dialect.sqlToQuery(clause).sql).join(", ");
  const sort = /^"chat_messages"\."(\w+)"\s+(asc|desc)$/i.exec(rendered);
  if (!sort) throw new Error(`unrecognised order by: ${rendered}`);
  return {
    text,
    orderBy: rendered,
    sortColumn: sort[1].toLowerCase(),
    descending: sort[2].toLowerCase() === "desc",
    below: positionBound(text, params, "<"),
    above: positionBound(text, params, ">"),
    since: sinceBound(text, params),
    excludesDeleted: /"chat_messages"\."is_deleted"\s*=\s*\$/i.test(text),
  };
}

class MessageStore {
  readonly rows: StoredMessage[] = [];
  private nextPosition = 1;

  constructor(count = 0, options: { ids?: readonly number[]; createdAt?: Date } = {}) {
    for (let i = 0; i < count; i++)
      this.insert({ id: options.ids?.[i], createdAt: options.createdAt });
  }

  insert(options: { id?: number; createdAt?: Date } = {}): StoredMessage {
    const channelPosition = this.nextPosition++;
    const row: StoredMessage = {
      id: options.id ?? channelPosition,
      orgId: ACTOR.orgId,
      channelId: CHANNEL_ID,
      channelPosition,
      createdAt: options.createdAt ?? new Date(Date.UTC(2024, 0, 1, 0, 0, channelPosition)),
      content: `m${channelPosition}`,
      isDeleted: false,
      metadata: null,
      senderMembership: null,
      replyTo: null,
      reactions: [],
      attachments: [],
    };
    this.rows.push(row);
    return row;
  }

  read(plan: ReadPlan, limit: number): StoredMessage[] {
    const sortKey = SORT_KEYS[plan.sortColumn];
    if (typeof sortKey !== "function")
      throw new Error(`this double cannot sort on ${plan.sortColumn}`);
    return this.rows
      .filter((row) => {
        if (plan.excludesDeleted && row.isDeleted) return false;
        if (plan.below !== undefined && row.channelPosition >= plan.below) return false;
        if (plan.above !== undefined && row.channelPosition <= plan.above) return false;
        if (plan.since !== undefined && row.createdAt <= plan.since) return false;
        return true;
      })
      .sort((a, b) => (plan.descending ? sortKey(b) - sortKey(a) : sortKey(a) - sortKey(b)))
      .slice(0, limit);
  }
}

interface Harness {
  readonly service: ChatMessageTimelineService;
  readonly store: MessageStore;
  readonly reads: ReadPlan[];
  onRead(fn: () => void): void;
}

async function buildHarness(store: MessageStore): Promise<Harness> {
  const reads: ReadPlan[] = [];
  let afterRead: (() => void) | undefined;

  const db = {
    query: {
      chatChannels: {
        findFirst: jest.fn().mockResolvedValue({ id: CHANNEL_ID, type: "PUBLIC" }),
      },
      chatChannelMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: ACTOR.membershipId }),
      },
      chatMessages: {
        findMany: jest.fn((config: { where: SQL; orderBy: SQL[]; limit: number }) => {
          const plan = readPlan(config.where, config.orderBy);
          reads.push(plan);
          const rows = store.read(plan, config.limit);
          if (afterRead) afterRead();
          return Promise.resolve(rows);
        }),
      },
    },
  };

  const entities = {
    withResolvedReferences: jest.fn((_actor: EntityActor, rows: unknown[]) =>
      Promise.resolve(rows),
    ),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      ChatMessageTimelineService,
      { provide: DRIZZLE, useValue: db },
      { provide: EntityReferenceService, useValue: entities },
    ],
  }).compile();

  return {
    service: moduleRef.get(ChatMessageTimelineService),
    store,
    reads,
    onRead: (fn) => {
      afterRead = fn;
    },
  };
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

interface Walk {
  readonly ids: number[];
  readonly positionPages: number[][];
}

interface Page {
  readonly messages: Array<{ id: number; channelPosition: number }>;
  readonly nextCursor: number | null;
}

async function walk(readPage: (cursor: number | undefined) => Promise<Page>): Promise<Walk> {
  const ids: number[] = [];
  const positionPages: number[][] = [];
  let cursor: number | undefined;
  for (let guard = 0; guard < 200; guard++) {
    const page = await readPage(cursor);
    ids.push(...page.messages.map((m) => m.id));
    positionPages.push(page.messages.map((m) => m.channelPosition));
    if (page.nextCursor == null) return { ids, positionPages };
    cursor = page.nextCursor;
  }
  throw new Error("paging did not terminate");
}

describe("chat timeline — the emitted sort and the emitted cursor are both channel_position", () => {
  it("list sorts by channel_position DESC and by nothing else", async () => {
    const harness = await buildHarness(new MessageStore(3));

    await harness.service.list(CHANNEL_ID, ACTOR, undefined, 10);

    expect(harness.reads[0]?.orderBy).toBe('"chat_messages"."channel_position" desc');
  });

  it("list bounds the next page with channel_position < cursor, never with the id", async () => {
    const harness = await buildHarness(new MessageStore(3));

    await harness.service.list(CHANNEL_ID, ACTOR, 17, 10);

    expect(harness.reads[0]?.below).toBe(17);
    expect(harness.reads[0]?.above).toBeUndefined();
    expect(harness.reads[0]?.text).not.toMatch(/"chat_messages"\."id"\s*[<>]/i);
  });

  it("poll sorts by channel_position ASC and bounds the next page with channel_position > cursor", async () => {
    const harness = await buildHarness(new MessageStore(3));

    await harness.service.poll(CHANNEL_ID, ACTOR, undefined, 17, 10);

    expect(harness.reads[0]?.orderBy).toBe('"chat_messages"."channel_position" asc');
    expect(harness.reads[0]?.above).toBe(17);
    expect(harness.reads[0]?.below).toBeUndefined();
    expect(harness.reads[0]?.text).not.toMatch(/"chat_messages"\."id"\s*[<>]/i);
  });
});

describe("chat timeline — a cursor walk visits every message exactly once", () => {
  it("holds when the id order disagrees with the commit order the position records", async () => {
    const store = new MessageStore(SHUFFLED_IDS.length, { ids: SHUFFLED_IDS });
    const harness = await buildHarness(store);
    expect(store.rows.every((row) => row.id !== row.channelPosition)).toBe(true);

    const { ids, positionPages } = await walk((cursor) =>
      harness.service.list(CHANNEL_ID, ACTOR, cursor, 5),
    );

    expect(duplicates(ids)).toEqual([]);
    expect([...ids].sort((a, b) => a - b)).toEqual(
      store.rows.map((row) => row.id).sort((a, b) => a - b),
    );
    for (const positions of positionPages)
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("holds for poll when every message shares one created_at", async () => {
    const tied = new Date("2024-03-01T09:00:00.000Z");
    const store = new MessageStore(17, { createdAt: tied });
    const harness = await buildHarness(store);

    const { ids } = await walk((cursor) =>
      harness.service.poll(CHANNEL_ID, ACTOR, EPOCH, cursor, 4),
    );

    expect(store.rows.every((row) => row.createdAt.getTime() === tied.getTime())).toBe(true);
    expect(duplicates(ids)).toEqual([]);
    expect(ids).toEqual(store.rows.map((row) => row.id));
  });

  it("holds for poll while new messages land ahead of the reader mid-walk", async () => {
    const store = new MessageStore(20);
    const harness = await buildHarness(store);
    const original = store.rows.map((row) => row.id);
    let writesLeft = 3;
    harness.onRead(() => {
      if (writesLeft-- <= 0) return;
      store.insert();
      store.insert();
    });

    const { ids } = await walk((cursor) =>
      harness.service.poll(CHANNEL_ID, ACTOR, EPOCH, cursor, 5),
    );

    expect(duplicates(ids)).toEqual([]);
    for (const id of original) expect(ids).toContain(id);
  });
});

describe("chat timeline — the next cursor comes from the last kept row", () => {
  it("poll points at the last returned message, not at the over-fetched sentinel", async () => {
    const harness = await buildHarness(new MessageStore(11));

    const first = await harness.service.poll(CHANNEL_ID, ACTOR, EPOCH, undefined, 10);

    expect(first.messages).toHaveLength(10);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(10);
    expect(first.messages[first.messages.length - 1]?.channelPosition).toBe(10);

    const second = await harness.service.poll(CHANNEL_ID, ACTOR, EPOCH, first.nextCursor ?? undefined, 10);

    expect(second.messages.map((m) => m.channelPosition)).toEqual([11]);
    expect(second.nextCursor).toBeNull();
  });

  it("list points at the oldest returned message, not at the over-fetched sentinel", async () => {
    const harness = await buildHarness(new MessageStore(11));

    const first = await harness.service.list(CHANNEL_ID, ACTOR, undefined, 10);

    expect(first.messages.map((m) => m.channelPosition)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(first.nextCursor).toBe(2);

    const second = await harness.service.list(CHANNEL_ID, ACTOR, first.nextCursor ?? undefined, 10);

    expect(second.messages.map((m) => m.channelPosition)).toEqual([1]);
    expect(second.nextCursor).toBeNull();
  });
});
