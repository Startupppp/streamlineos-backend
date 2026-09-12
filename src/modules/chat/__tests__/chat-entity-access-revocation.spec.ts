import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import type { AblyService } from "../../realtime/ably.service";
import type { StorageService } from "../../storage/storage.service";
import type { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import { ChatAttachmentsService } from "../chat-attachments.service";
import { ChatChannelListService } from "../chat-channel-list.service";
import { ChatChannelMembersService } from "../chat-channel-members.service";
import { ChatPinsService } from "../chat-pins.service";
import { ChatPresenceService } from "../chat-presence.service";
import { ChatSavedService } from "../chat-saved.service";
import { ChatSearchService } from "../chat-search.service";
import { ChatSummarizeService } from "../chat-summarize.service";

const ORG = "org-a";
const OTHER_ORG = "org-b";
const USER = "user-a";
const MEMBERSHIP = 77;
const RECORD_CHANNEL = 7;
const PLAIN_CHANNEL = 8;

const actor: EntityActor = {
  orgId: ORG,
  userId: USER,
  membershipId: MEMBERSHIP,
  isOrgOwner: false,
};

const RESOLVED = {
  status: "resolved" as const,
  card: {
    type: "project",
    id: "42",
    title: "Apollo",
    subtitle: null,
    status: "ACTIVE",
    href: "/build/42",
  },
};
const UNRESOLVED = {
  status: "unresolved" as const,
  reference: { type: "project", id: "42" },
};

type Resolution = typeof RESOLVED | typeof UNRESOLVED;

function entitiesThatAnswer(verdict: Resolution): EntityReferenceService {
  return {
    resolve: jest.fn((_a: EntityActor, refs: unknown[]) =>
      Promise.resolve(refs.map(() => verdict)),
    ),
    withResolvedReferences: jest.fn((_a: EntityActor, rows: unknown[]) =>
      Promise.resolve(rows),
    ),
  } as unknown as EntityReferenceService;
}

interface ChannelShape {
  id: number;
  isPrivate: boolean;
  entityType: string | null;
  entityId: string | null;
}

const RECORD_CHANNEL_ROW: ChannelShape = {
  id: RECORD_CHANNEL,
  isPrivate: true,
  entityType: "project",
  entityId: "42",
};

function memberDb(
  channel: ChannelShape | undefined,
  options: {
    member?: { role: string } | null;
    membership?: { id: number; isOwner: boolean } | undefined;
    rows?: unknown[];
  } = {},
) {
  const member = "member" in options ? options.member : { role: "MEMBER" };
  const membership =
    "membership" in options ? options.membership : { id: MEMBERSHIP, isOwner: false };
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(options.rows ?? []),
  };
  return {
    query: {
      chatChannels: {
        findFirst: jest
          .fn()
          .mockResolvedValue(channel === undefined ? undefined : { ...channel, members: [] }),
        findMany: jest.fn().mockResolvedValue(channel ? [{ ...channel, members: [] }] : []),
      },
      chatChannelMembers: {
        findFirst: jest.fn().mockResolvedValue(member),
        findMany: jest.fn().mockResolvedValue([]),
      },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(membership) },
      chatMessages: { findMany: jest.fn().mockResolvedValue(options.rows ?? []) },
      chatPinnedMessages: { findMany: jest.fn().mockResolvedValue(options.rows ?? []) },
      chatSavedMessages: { findMany: jest.fn().mockResolvedValue(options.rows ?? []) },
    },
    select: jest.fn(() => chain),
    execute: jest.fn().mockResolvedValue([{ id: 1 }]),
  } as unknown as Db;
}

function members(db: Db, entities: EntityReferenceService) {
  return new ChatChannelMembersService(
    db,
    {} as unknown as CacheService,
    entities,
    {} as unknown as AblyService,
  );
}

describe("record channel — a retained membership does not survive losing the record", () => {
  it("DENY: getChannel 404s once the record no longer resolves", async () => {
    const db = memberDb(RECORD_CHANNEL_ROW);
    await expect(
      members(db, entitiesThatAnswer(UNRESOLVED)).getChannel(RECORD_CHANNEL, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("CONTROL: getChannel answers while the record still resolves", async () => {
    const db = memberDb(RECORD_CHANNEL_ROW);
    const channel = await members(db, entitiesThatAnswer(RESOLVED)).getChannel(
      RECORD_CHANNEL,
      actor,
    );
    expect(channel).toMatchObject({ id: RECORD_CHANNEL });
  });

  it("DENY: listMembers 404s — the roster is part of the record, not of the membership row", async () => {
    const db = memberDb(RECORD_CHANNEL_ROW);
    await expect(
      members(db, entitiesThatAnswer(UNRESOLVED)).listMembers(RECORD_CHANNEL, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("DENY: listChannelFiles 404s before any attachment row is read", async () => {
    const db = memberDb(RECORD_CHANNEL_ROW);
    const service = members(db, entitiesThatAnswer(UNRESOLVED));
    await expect(
      service.listChannelFiles(RECORD_CHANNEL, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("CONTROL: listChannelFiles reads the attachments while the record resolves", async () => {
    const db = memberDb(RECORD_CHANNEL_ROW);
    await members(db, entitiesThatAnswer(RESOLVED)).listChannelFiles(RECORD_CHANNEL, actor);
    expect(db.select).toHaveBeenCalled();
  });

  it("DENY: a signed attachment URL is refused, and storage is never asked for one", async () => {
    const db = memberDb(RECORD_CHANNEL_ROW, { rows: [{ fileKey: `${ORG}/chat/a.pdf` }] });
    const entities = entitiesThatAnswer(UNRESOLVED);
    const storage = { getFileUrl: jest.fn() } as unknown as StorageService;
    const service = new ChatAttachmentsService(db, storage, members(db, entities));

    await expect(service.getSignedUrl(RECORD_CHANNEL, 1, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(storage.getFileUrl).not.toHaveBeenCalled();
  });

  it("CONTROL: the same attachment signs while the record resolves", async () => {
    const db = memberDb(RECORD_CHANNEL_ROW, { rows: [{ fileKey: `${ORG}/chat/a.pdf` }] });
    const entities = entitiesThatAnswer(RESOLVED);
    const storage = {
      getFileUrl: jest.fn().mockResolvedValue("https://signed"),
    } as unknown as StorageService;
    const service = new ChatAttachmentsService(db, storage, members(db, entities));

    await expect(service.getSignedUrl(RECORD_CHANNEL, 1, actor)).resolves.toEqual({
      url: "https://signed",
    });
  });

  it("DENY: pins 404 rather than returning the pinned message bodies", async () => {
    const db = memberDb(RECORD_CHANNEL_ROW);
    await expect(
      new ChatPinsService(db, entitiesThatAnswer(UNRESOLVED)).listPins(RECORD_CHANNEL, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("CONTROL: pins list while the record resolves", async () => {
    const db = memberDb(RECORD_CHANNEL_ROW);
    await expect(
      new ChatPinsService(db, entitiesThatAnswer(RESOLVED)).listPins(RECORD_CHANNEL, actor),
    ).resolves.toEqual([]);
  });

  it("DENY: an AI summary of the record channel is refused before any message is read", async () => {
    const db = memberDb(RECORD_CHANNEL_ROW);
    const service = new ChatSummarizeService(
      db,
      { get: jest.fn() } as never,
      entitiesThatAnswer(UNRESOLVED),
    );
    await expect(service.summarize(RECORD_CHANNEL, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe("record channel — durable copies of its content are withheld too", () => {
  const savedRow = (channel: Partial<ChannelShape> & { id: number }) => ({
    id: 1,
    message: {
      id: 5,
      metadata: null,
      senderMembership: null,
      reactions: [],
      attachments: [],
      channel: {
        id: channel.id,
        name: "Apollo",
        type: "GROUP",
        entityType: channel.entityType ?? null,
        entityId: channel.entityId ?? null,
      },
    },
  });

  it("DENY: a saved copy of a record-channel message leaves the saved list", async () => {
    const db = memberDb(RECORD_CHANNEL_ROW, {
      rows: [savedRow({ id: RECORD_CHANNEL, entityType: "project", entityId: "42" })],
    });
    const result = await new ChatSavedService(db, entitiesThatAnswer(UNRESOLVED)).list(actor);
    expect(result.items).toHaveLength(0);
  });

  it("CONTROL: a saved copy from an ordinary channel is untouched", async () => {
    const db = memberDb(RECORD_CHANNEL_ROW, { rows: [savedRow({ id: PLAIN_CHANNEL })] });
    const result = await new ChatSavedService(db, entitiesThatAnswer(UNRESOLVED)).list(actor);
    expect(result.items).toHaveLength(1);
  });

  it("DENY: a search hit inside a record channel is withheld, but the cursor still advances", async () => {
    const hit = {
      id: 9,
      metadata: null,
      senderMembership: null,
      channel: {
        id: RECORD_CHANNEL,
        name: "Apollo",
        type: "GROUP",
        entityType: "project",
        entityId: "42",
      },
    };
    const db = memberDb(RECORD_CHANNEL_ROW);
    (db.query.chatMessages.findMany as jest.Mock).mockResolvedValue([hit]);
    const result = await new ChatSearchService(db, entitiesThatAnswer(UNRESOLVED)).searchMessages(
      actor,
      "apollo",
      20,
    );
    expect(result.results).toHaveLength(0);
  });

  it("DENY: the second search route (/chat/search) withholds the same hit", async () => {
    const hit = {
      id: 9,
      metadata: null,
      senderMembership: null,
      channel: {
        id: RECORD_CHANNEL,
        name: "Apollo",
        type: "GROUP",
        entityType: "project",
        entityId: "42",
      },
    };
    const db = memberDb(RECORD_CHANNEL_ROW);
    (db.query.chatMessages.findMany as jest.Mock).mockResolvedValue([hit]);
    const results = await new ChatPresenceService(db, entitiesThatAnswer(UNRESOLVED)).searchMessages(
      actor,
      "apollo",
      undefined,
      20,
    );
    expect(results).toHaveLength(0);
  });

  it("CONTROL: /chat/search returns an ordinary-channel hit and strips the record columns", async () => {
    const hit = {
      id: 9,
      metadata: null,
      senderMembership: null,
      channel: {
        id: PLAIN_CHANNEL,
        name: "General",
        type: "PUBLIC",
        entityType: null,
        entityId: null,
      },
    };
    const db = memberDb(RECORD_CHANNEL_ROW);
    (db.query.chatMessages.findMany as jest.Mock).mockResolvedValue([hit]);
    const results = await new ChatPresenceService(db, entitiesThatAnswer(UNRESOLVED)).searchMessages(
      actor,
      "general",
      undefined,
      20,
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.channel).toEqual({ id: PLAIN_CHANNEL, name: "General", type: "PUBLIC" });
  });

  it("CONTROL: the same hit in an ordinary channel is returned, with no record columns on the wire", async () => {
    const hit = {
      id: 9,
      metadata: null,
      senderMembership: null,
      channel: {
        id: PLAIN_CHANNEL,
        name: "General",
        type: "PUBLIC",
        entityType: null,
        entityId: null,
      },
    };
    const db = memberDb(RECORD_CHANNEL_ROW);
    (db.query.chatMessages.findMany as jest.Mock).mockResolvedValue([hit]);
    const result = await new ChatSearchService(db, entitiesThatAnswer(UNRESOLVED)).searchMessages(
      actor,
      "general",
      20,
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.channel).toEqual({
      id: PLAIN_CHANNEL,
      name: "General",
      type: "PUBLIC",
    });
  });
});

describe("record channel — the realtime capability is minted from the record ACL", () => {
  function capabilityDb(rows: { channelId: number; entityType: string | null; entityId: string | null }[]) {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
    };
    return {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: MEMBERSHIP, isOwner: false }),
        },
      },
      select: jest.fn(() => chain),
    } as unknown as Db;
  }

  it("DENY: a record channel the caller has lost is not in the token's channel list", async () => {
    const db = capabilityDb([
      { channelId: PLAIN_CHANNEL, entityType: null, entityId: null },
      { channelId: RECORD_CHANNEL, entityType: "project", entityId: "42" },
    ]);
    const ids = await new ChatChannelListService(
      db,
      entitiesThatAnswer(UNRESOLVED),
    ).listMemberChannelIds(actor);
    expect(ids).toEqual([PLAIN_CHANNEL]);
  });

  it("CONTROL: both channels are granted while the record resolves", async () => {
    const db = capabilityDb([
      { channelId: PLAIN_CHANNEL, entityType: null, entityId: null },
      { channelId: RECORD_CHANNEL, entityType: "project", entityId: "42" },
    ]);
    const ids = await new ChatChannelListService(
      db,
      entitiesThatAnswer(RESOLVED),
    ).listMemberChannelIds(actor);
    expect(ids).toEqual([PLAIN_CHANNEL, RECORD_CHANNEL]);
  });
});

describe("chat membership negatives that do not depend on the record at all", () => {
  it("DENY: the org owner gets no implicit access to a private channel they never joined", async () => {
    const db = memberDb(
      { id: PLAIN_CHANNEL, isPrivate: true, entityType: null, entityId: null },
      { member: null, membership: { id: 1, isOwner: true } },
    );
    const ownerActor: EntityActor = { ...actor, membershipId: 1, isOrgOwner: true };
    await expect(
      members(db, entitiesThatAnswer(RESOLVED)).getChannel(PLAIN_CHANNEL, ownerActor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("DENY: the org owner gets no implicit access to someone else's DM", async () => {
    const db = memberDb(
      { id: 9, isPrivate: true, entityType: null, entityId: null },
      { member: null, membership: { id: 1, isOwner: true } },
    );
    const ownerActor: EntityActor = { ...actor, membershipId: 1, isOrgOwner: true };
    const thrown = await members(db, entitiesThatAnswer(RESOLVED))
      .getChannel(9, ownerActor)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(NotFoundException);
  });

  it("DENY: a DM non-participant is refused with the same 404 as a stranger", async () => {
    const db = memberDb(
      { id: 9, isPrivate: true, entityType: null, entityId: null },
      { member: null },
    );
    await expect(
      members(db, entitiesThatAnswer(RESOLVED)).getChannel(9, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("DENY: a suspended member is refused — liveness is read from organization_members, not from the channel row", async () => {
    const db = memberDb(RECORD_CHANNEL_ROW, { membership: undefined });
    await expect(
      members(db, entitiesThatAnswer(RESOLVED)).getChannel(RECORD_CHANNEL, actor),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("DENY: a channel id from another organization is 404 before membership is read", async () => {
    const db = memberDb(undefined);
    const foreign: EntityActor = { ...actor, orgId: OTHER_ORG };
    await expect(
      members(db, entitiesThatAnswer(RESOLVED)).getChannel(RECORD_CHANNEL, foreign),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.query.organizationMembers.findFirst).not.toHaveBeenCalled();
  });
});
