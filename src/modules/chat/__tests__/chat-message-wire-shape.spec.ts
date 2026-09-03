import { ChatMessageTimelineService } from "../chat-message-timeline.service";
import { ChatSavedService } from "../chat-saved.service";
import type { Db } from "../../../db/drizzle.module";
import type { EntityActor } from "../../entity-reference/entity-reference.types";

/**
 * The chat message payload, asserted on what the read paths RETURN — not on what a caller declares.
 *
 * `hooks/api/chat-core-read.ts` reads the timeline through `apiClient.get<MessagesPage>(...)`, a
 * cast. `types/chat.ts` has always declared `Message.senderId` and `Message.sender` at the top
 * level; `chat_messages` has no `sender_id` column at all, and every read path shipped the join
 * verbatim as `senderMembership`. A typecheck of either repo passed with the two shapes in open
 * disagreement — exactly the class of defect a typecheck cannot see, so nothing here relies on one.
 *
 * Every assertion drives the real service with a database double that answers in the NESTED shape
 * the Drizzle relational query actually produces.
 */

jest.mock("../../directory/person-seam", () => {
  const actual = jest.requireActual("../../directory/person-seam");
  return { ...actual, resolvePeopleIdentities: jest.fn() };
});

import { resolvePeopleIdentities, subjectKey } from "../../directory/person-seam";

const ORG = "org-1";
const CHANNEL = 42;
const ME = "user-me";
const OTHER = "user-other";
const MY_MEMBERSHIP = 11;

function actor(): EntityActor {
  return { orgId: ORG, userId: ME, membershipId: MY_MEMBERSHIP, isOrgOwner: false, permissions: [] } as unknown as EntityActor;
}

/** A message row exactly as `with: { senderMembership: { columns: { userId } } }` hands it back. */
function nestedMessageRow(userId: string | null, id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    orgId: ORG,
    channelId: CHANNEL,
    senderMembershipId: userId === null ? null : 11,
    content: `message ${id}`,
    replyToId: null,
    isEdited: false,
    isDeleted: false,
    messageType: "text",
    metadata: null,
    actionStatus: null,
    clientKey: null,
    channelPosition: id,
    createdAt: new Date("2026-09-01T10:00:00Z"),
    updatedAt: new Date("2026-09-01T10:00:00Z"),
    attachments: [],
    reactions: [],
    replyTo: null,
    senderMembership: userId === null ? null : { userId },
    ...over,
  };
}

/** A saved-message row: the identity arrives as `message.senderMembership.user`. */
function nestedSavedRow(userId: string | null, id: number) {
  return {
    id,
    orgId: ORG,
    membershipId: MY_MEMBERSHIP,
    messageId: id * 100,
    savedAt: new Date("2026-09-01T10:00:00Z"),
    message: {
      ...nestedMessageRow(userId, id * 100),
      channel: { id: CHANNEL, name: "general", type: "PUBLIC" },
      senderMembership:
        userId === null
          ? null
          : { userId, user: { id: userId, name: userId === ME ? "Me" : "Ada Lovelace", image: null } },
    },
  };
}

const identityFor = (userId: string) => ({
  userId,
  displayName: userId === ME ? "Me" : "Ada Lovelace",
  firstName: null,
  lastName: null,
  avatarUrl: null,
});

function primeIdentities(userIds: string[]) {
  const map = new Map(userIds.map((id) => [subjectKey({ kind: "user", userId: id }), identityFor(id)]));
  (resolvePeopleIdentities as unknown as jest.Mock).mockResolvedValue(map);
}

const entities = {
  withResolvedReferences: jest.fn((_actor: unknown, rows: unknown) => Promise.resolve(rows)),
};

function timelineDb(rows: unknown[]) {
  return {
    query: {
      chatChannels: { findFirst: jest.fn().mockResolvedValue({ id: CHANNEL, type: "PUBLIC" }) },
      chatChannelMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
      chatMessages: { findMany: jest.fn().mockResolvedValue(rows), findFirst: jest.fn().mockResolvedValue(null) },
    },
  } as unknown as Db;
}

function savedDb(rows: unknown[]) {
  return {
    query: { chatSavedMessages: { findMany: jest.fn().mockResolvedValue(rows) } },
  } as unknown as Db;
}

beforeEach(() => {
  jest.clearAllMocks();
  entities.withResolvedReferences.mockImplementation((_a: unknown, rows: unknown) => Promise.resolve(rows));
});

describe("chat message — the sender identity is at the top level, on every read path", () => {
  it("GET /chat/channels/:id/messages emits senderId, and no senderMembership wrapper", async () => {
    primeIdentities([ME, OTHER]);
    const service = new ChatMessageTimelineService(timelineDb([nestedMessageRow(ME, 1)]), entities as never);

    const { messages } = await service.list(CHANNEL, actor(), undefined, 30);

    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toHaveProperty("senderMembership");
    expect(messages[0]?.senderId).toBe(ME);
    expect(messages[0]?.sender).toEqual({ id: ME, name: "Me", image: null });
  });

  it("carries senderId onto the quoted replyTo as well, not only the message", async () => {
    primeIdentities([ME, OTHER]);
    const row = nestedMessageRow(ME, 1, {
      replyToId: 9,
      replyTo: { id: 9, content: "parent", senderMembership: { userId: OTHER } },
    });
    const service = new ChatMessageTimelineService(timelineDb([row]), entities as never);

    const { messages } = await service.list(CHANNEL, actor(), undefined, 30);

    expect(messages[0]?.replyTo).not.toHaveProperty("senderMembership");
    expect(messages[0]?.replyTo?.senderId).toBe(OTHER);
  });

  it("the poll fallback emits the identical shape, so a socket outage cannot change it", async () => {
    primeIdentities([ME]);
    const service = new ChatMessageTimelineService(timelineDb([nestedMessageRow(ME, 1)]), entities as never);

    const { messages } = await service.poll(CHANNEL, actor(), undefined, undefined, 30);

    expect(messages[0]).not.toHaveProperty("senderMembership");
    expect(messages[0]?.senderId).toBe(ME);
  });

  it("the thread read emits it on the parent and on every reply", async () => {
    primeIdentities([ME, OTHER]);
    const db = timelineDb([nestedMessageRow(OTHER, 2)]);
    (db.query.chatMessages.findFirst as unknown as jest.Mock).mockResolvedValue(nestedMessageRow(ME, 1));
    const service = new ChatMessageTimelineService(db, entities as never);

    const { parentMessage, replies } = await service.listThreadReplies(1, actor(), undefined, 30);

    expect(parentMessage).not.toHaveProperty("senderMembership");
    expect(parentMessage.senderId).toBe(ME);
    expect(replies[0]).not.toHaveProperty("senderMembership");
    expect(replies[0]?.senderId).toBe(OTHER);
  });

  it("a message whose organization row is gone lifts to null, never to a missing key", async () => {
    primeIdentities([]);
    const service = new ChatMessageTimelineService(timelineDb([nestedMessageRow(null, 1)]), entities as never);

    const { messages } = await service.list(CHANNEL, actor(), undefined, 30);

    expect(messages[0]?.senderId).toBeNull();
    expect(messages[0] && "senderId" in messages[0]).toBe(true);
  });

  it("GET /chat/saved flattens the sender the client renders, and the id beside it", async () => {
    const service = new ChatSavedService(savedDb([nestedSavedRow(OTHER, 1)]), entities as never);

    const { items } = await service.list(actor(), undefined, 30);

    expect(items).toHaveLength(1);
    expect(items[0]?.message).not.toHaveProperty("senderMembership");
    expect(items[0]?.message?.senderId).toBe(OTHER);
    expect(items[0]?.message?.sender).toEqual({ id: OTHER, name: "Ada Lovelace", image: null });
  });
});

/**
 * The consumer predicates, run against the real payload.
 *
 * `message-list.tsx:273` decides `isOwn` by `msg.senderId === currentUserId` — which right-aligns
 * a message and is the sole gate on the Edit and Delete controls in `chat-message-actions.tsx:77`
 * and `:78`. `:276` groups consecutive messages by `prevMsg?.senderId === msg.senderId`.
 * `saved-messages-panel.tsx:50` names a card by `resolveUserName(message.senderId, message.sender)`.
 *
 * Without the BITE cases this file would pass just as happily against the broken payload.
 */
describe("chat message — the consumer predicates against the real payload", () => {
  interface FlatMessage {
    senderId?: string | null;
    sender?: { id: string | null; name: string | null; image: string | null } | null;
  }

  const isOwn = (message: FlatMessage, me: string) => message.senderId === me;
  const isSameSender = (previous: FlatMessage, message: FlatMessage) => previous.senderId === message.senderId;
  const cardName = (message: FlatMessage) => message.sender?.name ?? "Unknown";

  const preFixMine = nestedMessageRow(ME, 1) as unknown as FlatMessage;
  const preFixTheirs = nestedMessageRow(OTHER, 2) as unknown as FlatMessage;

  it("BITE: the pre-fix payload makes isOwn false for a message the caller sent themselves", () => {
    expect(isOwn(preFixMine, ME)).toBe(false);
  });

  it("BITE: the pre-fix payload groups two DIFFERENT senders under one header, because undefined === undefined", () => {
    expect(isSameSender(preFixTheirs, preFixMine)).toBe(true);
  });

  it("BITE: the pre-fix saved row renders every card as Unknown, because sender was never flattened", () => {
    const preFixSaved = nestedSavedRow(OTHER, 1).message as unknown as FlatMessage;
    expect(cardName(preFixSaved)).toBe("Unknown");
  });

  it("the served timeline resolves isOwn against the caller's own user id", async () => {
    primeIdentities([ME, OTHER]);
    const service = new ChatMessageTimelineService(
      timelineDb([nestedMessageRow(ME, 1), nestedMessageRow(OTHER, 2)]),
      entities as never,
    );

    const { messages } = await service.list(CHANNEL, actor(), undefined, 30);
    const mine = messages.find((m) => m.senderId === ME);
    const theirs = messages.find((m) => m.senderId === OTHER);

    expect(mine && isOwn(mine, ME)).toBe(true);
    expect(theirs && isOwn(theirs, ME)).toBe(false);
  });

  it("the served timeline keeps two different senders in two different groups", async () => {
    primeIdentities([ME, OTHER]);
    const service = new ChatMessageTimelineService(
      timelineDb([nestedMessageRow(ME, 1), nestedMessageRow(OTHER, 2)]),
      entities as never,
    );

    const { messages } = await service.list(CHANNEL, actor(), undefined, 30);

    expect(messages).toHaveLength(2);
    expect(isSameSender(messages[0] as FlatMessage, messages[1] as FlatMessage)).toBe(false);
  });

  it("the served saved list names each card with the sender's real name", async () => {
    const service = new ChatSavedService(savedDb([nestedSavedRow(OTHER, 1)]), entities as never);

    const { items } = await service.list(actor(), undefined, 30);

    expect(cardName(items[0]?.message as FlatMessage)).toBe("Ada Lovelace");
  });
});
