import { NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ChatMessagesService } from "../chat-messages.service";
import { ChatMessageTimelineService } from "../chat-message-timeline.service";
import { chatMessagePageSchema } from "../dto/chat-messages-response.schemas";
import type { Db } from "../../../db/drizzle.module";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import type { EntityReferenceService } from "../../entity-reference/entity-reference.service";

jest.mock("../../../common/tenant/tenant-context", () => ({
  ...jest.requireActual("../../../common/tenant/tenant-context"),
  registerAfterCommit: jest.fn(() => true),
}));

jest.mock("../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: {
    emit: jest.fn(() => Promise.resolve()),
    emitMany: jest.fn(() => Promise.resolve()),
  },
}));

jest.mock("../../directory/person-seam", () => ({
  ...jest.requireActual("../../directory/person-seam"),
  resolvePeopleIdentities: jest.fn(),
}));

import { resolvePeopleIdentities, subjectKey } from "../../directory/person-seam";

const dialect = new PgDialect();

const ORG = "org-1";
const HOME_CHANNEL = 10;
const PRIVATE_CHANNEL = 42;
const SENDER = "user-sender";
const OTHER = "user-other";

const HOME_MESSAGE = 500;
const PRIVATE_MESSAGE = 900;
const DELETED_HOME_MESSAGE = 901;

interface StoredMessage {
  id: number;
  channelId: number;
  isDeleted: boolean;
}

const STORE: readonly StoredMessage[] = [
  { id: HOME_MESSAGE, channelId: HOME_CHANNEL, isDeleted: false },
  { id: PRIVATE_MESSAGE, channelId: PRIVATE_CHANNEL, isDeleted: false },
  { id: DELETED_HOME_MESSAGE, channelId: HOME_CHANNEL, isDeleted: true },
];

interface RenderedPredicate {
  text: string;
  params: readonly unknown[];
}

function boundValue(rendered: RenderedPredicate, column: string): unknown {
  const match = new RegExp(`"chat_messages"\\."${column}"\\s*=\\s*\\$(\\d+)`).exec(rendered.text);
  if (!match) return undefined;
  return rendered.params[Number(match[1]) - 1];
}

function resolveFromRenderedPredicate(rendered: RenderedPredicate): { id: number } | undefined {
  const id = boundValue(rendered, "id");
  const orgId = boundValue(rendered, "org_id");
  const channelId = boundValue(rendered, "channel_id");
  const isDeleted = boundValue(rendered, "is_deleted");
  if (orgId !== undefined && orgId !== ORG) return undefined;
  const row = STORE.find(
    (message) =>
      message.id === id &&
      (channelId === undefined || message.channelId === channelId) &&
      (isDeleted === undefined || message.isDeleted === isDeleted),
  );
  return row === undefined ? undefined : { id: row.id };
}

function resolveFromRenderedPredicateIgnoringChannel(
  rendered: RenderedPredicate,
): StoredMessage | undefined {
  const id = boundValue(rendered, "id");
  return STORE.find((message) => message.id === id && !message.isDeleted);
}

interface SendHarness {
  readonly service: ChatMessagesService;
  readonly predicates: RenderedPredicate[];
  readonly inserted: Array<Record<string, unknown>>;
}

function sendHarness(): SendHarness {
  const predicates: RenderedPredicate[] = [];
  const inserted: Array<Record<string, unknown>> = [];

  const selectRows: unknown[][] = [
    [{ id: HOME_CHANNEL, type: "PUBLIC" }],
    [{ name: "Ada", image: null }],
  ];
  const selectChain = {
    from: () => selectChain,
    innerJoin: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(selectRows.shift() ?? []),
  };

  const updateResult = {
    returning: () => Promise.resolve([{ position: 4 }]),
    then: (resolve: (value: unknown) => unknown) => resolve(undefined),
  };
  const updateChain = {
    set: () => updateChain,
    where: () => updateResult,
  };

  const insertResult = {
    onConflictDoNothing: () => insertResult,
    returning: () =>
      Promise.resolve([
        {
          id: 1234,
          orgId: ORG,
          channelId: HOME_CHANNEL,
          replyToId: inserted[0]?.["replyToId"] ?? null,
          metadata: null,
          createdAt: new Date("2026-09-09T10:00:00.000Z"),
        },
      ]),
    then: (resolve: (value: unknown) => unknown) => resolve(undefined),
  };
  const insertChain = {
    values: (values: Record<string, unknown>) => {
      inserted.push(values);
      return insertResult;
    },
  };

  const double: Record<string, unknown> = {
    select: () => selectChain,
    update: () => updateChain,
    insert: () => insertChain,
    query: {
      chatMessages: {
        findFirst: jest.fn(({ where }: { where: SQL }) => {
          const { sql: text, params } = dialect.sqlToQuery(where);
          const rendered: RenderedPredicate = { text, params };
          predicates.push(rendered);
          return Promise.resolve(resolveFromRenderedPredicate(rendered));
        }),
      },
      chatChannels: {
        findFirst: () => Promise.resolve({ id: HOME_CHANNEL, isPrivate: false }),
      },
      organizationMembers: { findFirst: () => Promise.resolve({ id: 77 }) },
      chatChannelMembers: { findFirst: () => Promise.resolve({ role: "MEMBER" }) },
    },
  };
  double["transaction"] = (run: (tx: unknown) => Promise<unknown>) => run(double);

  const cache = { invalidateNamespace: jest.fn(() => Promise.resolve()) };
  const ably = { publishChatMessage: jest.fn(() => Promise.resolve()) };
  const replyReminders = { scheduleForMessage: jest.fn(() => Promise.resolve()) };
  const orgSettings = { getSettings: jest.fn(() => Promise.resolve({ maxAttachmentSizeMb: 25 })) };
  const storage = { isValidFileKey: jest.fn(() => true) };
  const fanout = { dispatchRealtime: jest.fn(() => Promise.resolve()) };

  const service = new ChatMessagesService(
    double as unknown as Db,
    cache as never,
    ably as never,
    replyReminders as never,
    orgSettings as never,
    storage as never,
    { resolve: jest.fn(() => Promise.resolve([])) } as never,
    fanout as never,
  );

  return { service, predicates, inserted };
}

describe("a reply target must live in the channel being written to", () => {
  it("DENY: quoting a message that lives in another channel is 404, and nothing is inserted", async () => {
    const harness = sendHarness();

    await expect(
      harness.service.send(HOME_CHANNEL, SENDER, ORG, { content: ".", replyToId: PRIVATE_MESSAGE }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(harness.inserted).toHaveLength(0);
  });

  it("the compiled predicate binds channel_id, org_id, id and is_deleted", async () => {
    const harness = sendHarness();

    await harness.service
      .send(HOME_CHANNEL, SENDER, ORG, { content: ".", replyToId: PRIVATE_MESSAGE })
      .catch(() => undefined);

    expect(harness.predicates).toHaveLength(1);
    const rendered = harness.predicates[0];
    expect(rendered).toBeDefined();
    if (rendered === undefined) return;
    expect(rendered.text).toMatch(/"chat_messages"\."channel_id"\s*=\s*\$\d+/);
    expect(rendered.text).toMatch(/"chat_messages"\."org_id"\s*=\s*\$\d+/);
    expect(rendered.text).toMatch(/"chat_messages"\."id"\s*=\s*\$\d+/);
    expect(rendered.text).toMatch(/"chat_messages"\."is_deleted"/);
    expect(boundValue(rendered, "channel_id")).toBe(HOME_CHANNEL);
    expect(boundValue(rendered, "org_id")).toBe(ORG);
    expect(boundValue(rendered, "id")).toBe(PRIVATE_MESSAGE);
  });

  it("BITE: drop the channel binding from that same predicate and the private message resolves", async () => {
    const harness = sendHarness();

    await harness.service
      .send(HOME_CHANNEL, SENDER, ORG, { content: ".", replyToId: PRIVATE_MESSAGE })
      .catch(() => undefined);

    const rendered = harness.predicates[0];
    expect(rendered).toBeDefined();
    if (rendered === undefined) return;
    const leaked = resolveFromRenderedPredicateIgnoringChannel(rendered);
    expect(leaked).toBeDefined();
    expect(leaked?.channelId).toBe(PRIVATE_CHANNEL);
  });

  it("DENY: a soft-deleted target in the caller's own channel is 404 too", async () => {
    const harness = sendHarness();

    await expect(
      harness.service.send(HOME_CHANNEL, SENDER, ORG, {
        content: ".",
        replyToId: DELETED_HOME_MESSAGE,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("ALLOW: quoting a message in the same channel inserts the reply pointer", async () => {
    const harness = sendHarness();

    await harness.service.send(HOME_CHANNEL, SENDER, ORG, {
      content: "quoting",
      replyToId: HOME_MESSAGE,
    });

    expect(harness.inserted).toHaveLength(1);
    expect(harness.inserted[0]?.["replyToId"]).toBe(HOME_MESSAGE);
  });

  it("a send with no replyToId never runs the lookup", async () => {
    const harness = sendHarness();

    await harness.service.send(HOME_CHANNEL, SENDER, ORG, { content: "plain" });

    expect(harness.predicates).toHaveLength(0);
    expect(harness.inserted[0]?.["replyToId"]).toBeUndefined();
  });
});

interface RelationOptions {
  columns?: Record<string, boolean>;
  with?: Record<string, RelationOptions>;
}

const REPLY_PREVIEW_COLUMNS = ["content", "id"];

function actor(): EntityActor {
  return { orgId: ORG, userId: SENDER, membershipId: 77, isOrgOwner: false };
}

function timelineService(rows: unknown[], capture?: (options: RelationOptions) => void) {
  const record = (options: RelationOptions) => {
    if (capture) capture(options);
  };
  const db = {
    query: {
      chatChannels: {
        findFirst: jest.fn(() => Promise.resolve({ id: HOME_CHANNEL, type: "PUBLIC" })),
      },
      chatChannelMembers: { findFirst: jest.fn(() => Promise.resolve({ id: 1 })) },
      chatMessages: {
        findMany: jest.fn((options: RelationOptions) => {
          record(options);
          return Promise.resolve(rows);
        }),
        findFirst: jest.fn((options: RelationOptions) => {
          record(options);
          return Promise.resolve(rows[0]);
        }),
      },
    },
  } as unknown as Db;
  const entities = {
    withResolvedReferences: jest.fn((_actor: unknown, messages: unknown) =>
      Promise.resolve(messages),
    ),
  } as unknown as EntityReferenceService;
  return new ChatMessageTimelineService(db, entities);
}

function replyProjections(options: RelationOptions, found: RelationOptions[] = []) {
  for (const [key, relation] of Object.entries(options.with ?? {})) {
    if (typeof relation !== "object" || relation === null) continue;
    if (key === "replyTo") found.push(relation);
    replyProjections(relation, found);
  }
  return found;
}

function assertBounded(options: RelationOptions) {
  const projections = replyProjections(options);
  expect(projections.length).toBeGreaterThan(0);
  for (const projection of projections) {
    expect(projection.columns).toBeDefined();
    expect(Object.keys(projection.columns ?? {}).sort()).toEqual(REPLY_PREVIEW_COLUMNS);
    expect(Object.keys(projection.with ?? {})).toEqual(["senderMembership"]);
    expect(Object.keys(projection.with?.["senderMembership"]?.columns ?? {})).toEqual(["userId"]);
  }
}

describe("the quoted parent is projected to a bounded column set", () => {
  beforeEach(() => {
    primeIdentities([SENDER, OTHER]);
  });

  it("the timeline list asks for id and content only", async () => {
    const seen: RelationOptions[] = [];
    const service = timelineService([], (options) => seen.push(options));

    await service.list(HOME_CHANNEL, actor(), undefined, 50);

    expect(seen).toHaveLength(1);
    for (const options of seen) assertBounded(options);
  });

  it("the poll fallback asks for the same set, so a socket outage cannot widen it", async () => {
    const seen: RelationOptions[] = [];
    const service = timelineService([], (options) => seen.push(options));

    await service.poll(HOME_CHANNEL, actor(), undefined, undefined, 50);

    expect(seen).toHaveLength(1);
    for (const options of seen) assertBounded(options);
  });

  it("both thread reads — the parent lookup and the replies page — ask for the same set", async () => {
    const seen: RelationOptions[] = [];
    const service = timelineService([rowWithReply(OTHER)], (options) => seen.push(options));

    await service.listThreadReplies(HOME_MESSAGE, actor(), undefined, 50);

    expect(seen).toHaveLength(2);
    for (const options of seen) assertBounded(options);
  });
});

const identityFor = (userId: string) => ({
  userId,
  displayName: userId === SENDER ? "Ada" : "Grace",
  firstName: null,
  lastName: null,
  avatarUrl: null,
});

function primeIdentities(userIds: readonly string[]) {
  const identities = new Map(
    userIds.map((userId) => [subjectKey({ kind: "user", userId }), identityFor(userId)]),
  );
  (resolvePeopleIdentities as unknown as jest.Mock).mockResolvedValue(identities);
}

function rowWithReply(replySenderId: string | null) {
  return {
    id: 1,
    orgId: ORG,
    channelId: HOME_CHANNEL,
    senderMembershipId: 77,
    content: "quoting you",
    replyToId: HOME_MESSAGE,
    isEdited: false,
    isDeleted: false,
    messageType: "text",
    metadata: null,
    actionStatus: null,
    clientKey: null,
    channelPosition: 12,
    createdAt: new Date("2026-09-09T10:00:00.000Z"),
    updatedAt: new Date("2026-09-09T10:00:00.000Z"),
    attachments: [],
    reactions: [],
    senderMembership: { userId: SENDER },
    replyTo: {
      id: HOME_MESSAGE,
      content: "the parent",
      senderMembership: replySenderId === null ? null : { userId: replySenderId },
    },
  };
}

describe("a page containing a reply satisfies its own response contract", () => {
  it("parses through chatMessagePageSchema", async () => {
    primeIdentities([SENDER, OTHER]);
    const service = timelineService([rowWithReply(OTHER)]);

    const page = await service.list(HOME_CHANNEL, actor(), undefined, 50);
    const parsed = chatMessagePageSchema.safeParse(page);

    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("parses when the quoted sender's membership row is gone, so sender.id is null", async () => {
    primeIdentities([SENDER]);
    const service = timelineService([rowWithReply(null)]);

    const page = await service.list(HOME_CHANNEL, actor(), undefined, 50);
    const parsed = chatMessagePageSchema.safeParse(page);

    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(page.messages[0]?.replyTo?.sender.id).toBeNull();
  });

  it("BITE: the enriched replyTo has neither reactions nor attachments — what the old contract demanded", async () => {
    primeIdentities([SENDER, OTHER]);
    const service = timelineService([rowWithReply(OTHER)]);

    const page = await service.list(HOME_CHANNEL, actor(), undefined, 50);
    const replyTo = page.messages[0]?.replyTo;

    expect(replyTo).toBeDefined();
    expect(replyTo).not.toHaveProperty("reactions");
    expect(replyTo).not.toHaveProperty("attachments");
  });

  it("the quoted parent carries no channelId, orgId or metadata onto the wire", async () => {
    primeIdentities([SENDER, OTHER]);
    const service = timelineService([rowWithReply(OTHER)]);

    const page = await service.list(HOME_CHANNEL, actor(), undefined, 50);
    const replyTo = page.messages[0]?.replyTo;

    expect(replyTo).toBeDefined();
    expect(Object.keys(replyTo ?? {}).sort()).toEqual(["content", "id", "sender", "senderId"]);
  });
});
