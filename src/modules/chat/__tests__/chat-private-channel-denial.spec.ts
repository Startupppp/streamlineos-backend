import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { Db } from "../../../db/drizzle.module";
import { AblyService } from "../../realtime/ably.service";
import { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import { ChatPinsService } from "../chat-pins.service";
import { ChatReactionsService } from "../chat-reactions.service";
import { ChatSummarizeService } from "../chat-summarize.service";
import { ChatMessagesService } from "../chat-messages.service";
import type { EntityActor } from "../../entity-reference/entity-reference.types";

/**
 * A 403 on a private channel answers "this channel exists"; a 404 answers nothing.
 * The distinction is the whole control, so every case below is paired with a public
 * channel that must still return 403 — a blanket 404 would pass a one-sided test.
 */
const ORG = "org-a";
const USER = "user-a";
const MEMBERSHIP = 11;
const CHANNEL_ID = 42;
const MESSAGE_ID = 99;

const actor: EntityActor = {
  orgId: ORG,
  userId: USER,
  membershipId: MEMBERSHIP,
  isOrgOwner: false,
};

function dbWithChannel(isPrivate: boolean, opts: { member?: unknown } = {}) {
  const member = "member" in opts ? opts.member : null;
  return {
    query: {
      chatChannels: { findFirst: jest.fn().mockResolvedValue({ id: CHANNEL_ID, isPrivate }) },
      chatChannelMembers: { findFirst: jest.fn().mockResolvedValue(member) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: MEMBERSHIP }) },
      chatMessageReactions: { findMany: jest.fn().mockResolvedValue([]) },
    },
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([{ id: MESSAGE_ID }]),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockReturnThis(),
  };
}

function pins(db: ReturnType<typeof dbWithChannel>) {
  return new ChatPinsService(db as unknown as Db, {} as unknown as EntityReferenceService);
}

function reactions(db: ReturnType<typeof dbWithChannel>) {
  return new ChatReactionsService(db as unknown as Db, {
    publishChatEvent: jest.fn().mockResolvedValue(undefined),
  } as unknown as AblyService);
}

function summarize(db: ReturnType<typeof dbWithChannel>) {
  return new ChatSummarizeService(db as unknown as Db, { get: jest.fn() } as unknown as ModuleRef);
}

describe("private-channel denial does not disclose existence", () => {
  describe("ChatPinsService.pin", () => {
    it("DENY: a non-member of a PRIVATE channel gets 404, not 403", async () => {
      const db = dbWithChannel(true);
      await expect(pins(db).pin(CHANNEL_ID, MESSAGE_ID, actor)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("CONTROL: a non-member of a PUBLIC channel still gets 403", async () => {
      const db = dbWithChannel(false);
      await expect(pins(db).pin(CHANNEL_ID, MESSAGE_ID, actor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it("CONTROL: a channel in another organization is 404 before membership is read", async () => {
      const db = dbWithChannel(false);
      db.query.chatChannels.findFirst.mockResolvedValue(undefined);
      await expect(pins(db).pin(CHANNEL_ID, MESSAGE_ID, actor)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(db.query.chatChannelMembers.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("ChatReactionsService.addReaction", () => {
    it("DENY: a non-member of a PRIVATE channel gets 404, not 403", async () => {
      const db = dbWithChannel(true);
      await expect(
        reactions(db).addReaction(CHANNEL_ID, MESSAGE_ID, USER, ORG, "👍"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("CONTROL: a non-member of a PUBLIC channel still gets 403", async () => {
      const db = dbWithChannel(false);
      await expect(
        reactions(db).addReaction(CHANNEL_ID, MESSAGE_ID, USER, ORG, "👍"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("binds the reacted-to message to the caller organization", async () => {
      const db = dbWithChannel(false, { member: { id: MEMBERSHIP } });
      await reactions(db).addReaction(CHANNEL_ID, MESSAGE_ID, USER, ORG, "👍");
      const clause = db.where.mock.calls[0]?.[0];
      expect(sqlValues(clause)).toContain(ORG);
    });
  });

  describe("ChatSummarizeService.summarize", () => {
    it("DENY: a non-member of a PRIVATE channel gets 404, not 403", async () => {
      const db = dbWithChannel(true);
      await expect(summarize(db).summarize(CHANNEL_ID, { orgId: ORG, userId: USER })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("CONTROL: a non-member of a PUBLIC channel still gets 403", async () => {
      const db = dbWithChannel(false);
      await expect(summarize(db).summarize(CHANNEL_ID, { orgId: ORG, userId: USER })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});

describe("ChatMessagesService.sendThreadReply parent lookup", () => {
  it("binds the parent message to the caller organization", async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const db = { query: { chatMessages: { findFirst } } };
    const service = new ChatMessagesService(
      db as unknown as Db,
      ...(Array(6).fill({}) as [never, never, never, never, never, never]),
    );

    await expect(
      service.sendThreadReply(CHANNEL_ID, MESSAGE_ID, USER, ORG, { content: "hi" } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Without the org predicate a colliding message id from another tenant resolves
    // here and only the composite FK stops the insert — a 500 in place of a 404.
    expect(sqlValues(findFirst.mock.calls[0]?.[0]?.where)).toContain(ORG);
  });
});

function sqlValues(where: unknown, seen = new Set<object>()): unknown[] {
  if (where === null || where === undefined || typeof where !== "object") return [where];
  if (Array.isArray(where)) return where.flatMap((v) => sqlValues(v, seen));
  if (seen.has(where)) return [];
  seen.add(where);
  const rec = where as Record<string, unknown>;
  return [
    ...(Array.isArray(rec.queryChunks) ? sqlValues(rec.queryChunks, seen) : []),
    ...("value" in rec ? sqlValues(rec.value, seen) : []),
  ];
}
