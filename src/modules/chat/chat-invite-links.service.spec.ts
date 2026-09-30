import { createHash } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ChatInviteLinksService } from "./chat-invite-links.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { chatChannelInviteLinks, chatChannelMembers } from "../../db/schema";

const CHANNEL_ID = 1;
const ORG_ID = "org1";
const USER_ID = "user1";
const MEMBERSHIP_ID = 42;
const LINK_ID = 99;

const makeUpdateChain = (returningValue: Array<{ id: number }> = [{ id: LINK_ID }]) => ({
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnValue(
    Object.assign(Promise.resolve(undefined), {
      returning: jest.fn().mockResolvedValue(returningValue),
    }),
  ),
});

const makeInsertChain = (returningValue: Array<{ id: number }> = [{ id: LINK_ID }]) => ({
  values: jest.fn().mockReturnValue(
    Object.assign(Promise.resolve(undefined), {
      onConflictDoNothing: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(returningValue),
      }),
      returning: jest.fn().mockResolvedValue(returningValue),
    }),
  ),
});

function buildMockDb() {
  const db = {
    query: {
      chatChannels: { findFirst: jest.fn() },
      chatChannelMembers: { findFirst: jest.fn() },
      chatChannelInviteLinks: { findFirst: jest.fn() },
      organizationMembers: { findFirst: jest.fn() },
    },
    insert: jest.fn(),
    update: jest.fn(),
    transaction: jest.fn(),
  };
  db.insert.mockReturnValue(makeInsertChain());
  db.update.mockReturnValue(makeUpdateChain());
  db.transaction.mockImplementation((cb: (tx: typeof db) => unknown) => cb(db));
  return db;
}

let mockDb: ReturnType<typeof buildMockDb>;

describe("ChatInviteLinksService", () => {
  let service: ChatInviteLinksService;

  beforeEach(async () => {
    mockDb = buildMockDb();
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: MEMBERSHIP_ID });
    const module: TestingModule = await Test.createTestingModule({
      providers: [ChatInviteLinksService, { provide: DRIZZLE, useValue: mockDb }],
    }).compile();
    service = module.get(ChatInviteLinksService);
  });

  describe("getOrCreateInviteLink", () => {
    it("throws NotFoundException when caller is not in the org", async () => {
      mockDb.query.organizationMembers.findFirst.mockResolvedValueOnce(null);
      await expect(service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID)).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when caller is not a member of this channel", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce(null);
      await expect(service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID)).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException if requester is not an admin", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ role: "MEMBER", orgId: ORG_ID, membershipId: MEMBERSHIP_ID });
      await expect(service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID)).rejects.toThrow(ForbiddenException);
    });

    it("returns the existing active token without creating a new one", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ role: "ADMIN", orgId: ORG_ID, membershipId: MEMBERSHIP_ID });
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({
        token: "existing-token",
        tokenEncrypted: null,
        expiresAt: null,
        maxUses: null,
        useCount: 0,
      });
      const result = await service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID);
      expect(result).toEqual({ token: "existing-token", expiresAt: null, maxUses: null, useCount: 0 });
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("creates a new token when none exists and the transaction callback is invoked", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ role: "ADMIN", orgId: ORG_ID, membershipId: MEMBERSHIP_ID });
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValue(undefined);
      const result = await service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID);
      expect(mockDb.transaction).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
      expect(typeof result.token).toBe("string");
      expect(result.token.length).toBeGreaterThan(0);
    });

    it("respects ttlSeconds: expiresAt is set to approximately now + ttl", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ role: "ADMIN", orgId: ORG_ID, membershipId: MEMBERSHIP_ID });
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValue(undefined);
      const before = Date.now();
      const result = await service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID, { ttlSeconds: 3600 });
      const after = Date.now();
      expect(result.expiresAt).toBeInstanceOf(Date);
      const ts = (result.expiresAt as Date).getTime();
      expect(ts).toBeGreaterThanOrEqual(before + 3599_000);
      expect(ts).toBeLessThanOrEqual(after + 3601_000);
    });

    it("respects maxUses: returned in the response", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ role: "ADMIN", orgId: ORG_ID, membershipId: MEMBERSHIP_ID });
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValue(undefined);
      const result = await service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID, { maxUses: 5 });
      expect(result.maxUses).toBe(5);
      expect(result.useCount).toBe(0);
    });
  });

  describe("regenerateInviteLink", () => {
    it("revokes the old link and issues a new token", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ role: "ADMIN", orgId: ORG_ID, membershipId: MEMBERSHIP_ID });
      const result = await service.regenerateInviteLink(CHANNEL_ID, USER_ID, ORG_ID);
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
      expect(typeof result.token).toBe("string");
    });

    it("respects ttlSeconds and maxUses on regenerate", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ role: "ADMIN", orgId: ORG_ID, membershipId: MEMBERSHIP_ID });
      const result = await service.regenerateInviteLink(CHANNEL_ID, USER_ID, ORG_ID, { ttlSeconds: 7200, maxUses: 10 });
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.maxUses).toBe(10);
    });
  });

  describe("joinViaInviteLink", () => {
    it("throws NotFoundException for an unknown or revoked token (SQL predicate returns no row)", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce(undefined);
      await expect(service.joinViaInviteLink("bad-token", USER_ID, ORG_ID)).rejects.toThrow(NotFoundException);
    });

    it("throws the SAME NotFoundException message for an expired link, leaving no oracle", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce(undefined);
      let msg1: string | undefined;
      try {
        await service.joinViaInviteLink("expired-token", USER_ID, ORG_ID);
      } catch (e) {
        msg1 = e instanceof NotFoundException ? e.message : undefined;
      }

      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce(undefined);
      let msg2: string | undefined;
      try {
        await service.joinViaInviteLink("exhausted-token", USER_ID, ORG_ID);
      } catch (e) {
        msg2 = e instanceof NotFoundException ? e.message : undefined;
      }

      expect(msg1).toBeDefined();
      expect(msg1).toBe(msg2);
    });

    it("throws NotFoundException when the channel belongs to a different org (DB returns null because WHERE filters orgId)", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({ id: LINK_ID, channelId: CHANNEL_ID });
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce(null);
      await expect(service.joinViaInviteLink("tok", USER_ID, ORG_ID)).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when the channel is archived", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({ id: LINK_ID, channelId: CHANNEL_ID });
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: CHANNEL_ID, orgId: ORG_ID, isArchived: true });
      await expect(service.joinViaInviteLink("tok", USER_ID, ORG_ID)).rejects.toThrow(NotFoundException);
    });

    it("adds the user as a member and increments use_count when the token and org are valid", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({ id: LINK_ID, channelId: CHANNEL_ID });
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: CHANNEL_ID, orgId: ORG_ID, isArchived: false });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce(undefined);
      const result = await service.joinViaInviteLink("tok", USER_ID, ORG_ID);
      expect(mockDb.transaction).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.update).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, channelId: CHANNEL_ID });
    });

    it("starts the joiner's read cursor at the channel's high-water mark, not at 0", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({ id: LINK_ID, channelId: CHANNEL_ID });
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: CHANNEL_ID, orgId: ORG_ID, isArchived: false });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce(undefined);
      const insertChain = makeInsertChain();
      mockDb.insert.mockReturnValueOnce(insertChain);

      await service.joinViaInviteLink("tok", USER_ID, ORG_ID);

      const row = insertChain.values.mock.calls[0]?.[0] as { lastReadPosition?: SQL };
      expect(row.lastReadPosition).toBeDefined();
      expect(new PgDialect().sqlToQuery(row.lastReadPosition as SQL).sql).toContain('"message_count"');
    });

    it("does NOT insert a duplicate membership or increment use_count when the user already belongs", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({ id: LINK_ID, channelId: CHANNEL_ID });
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: CHANNEL_ID, orgId: ORG_ID, isArchived: false });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce({ id: 7 });
      const result = await service.joinViaInviteLink("tok", USER_ID, ORG_ID);
      expect(mockDb.insert).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, channelId: CHANNEL_ID });
    });

    it("throws NotFoundException if the link becomes invalid between the outer check and the use_count increment", async () => {
      mockDb.query.chatChannelInviteLinks.findFirst.mockResolvedValueOnce({ id: LINK_ID, channelId: CHANNEL_ID });
      mockDb.query.chatChannels.findFirst.mockResolvedValueOnce({ id: CHANNEL_ID, orgId: ORG_ID, isArchived: false });
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValueOnce(undefined);
      mockDb.update.mockReturnValueOnce({
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnValue(
          Object.assign(Promise.resolve(undefined), {
            returning: jest.fn().mockResolvedValue([]),
          }),
        ),
      });
      await expect(service.joinViaInviteLink("tok", USER_ID, ORG_ID)).rejects.toThrow(NotFoundException);
    });
  });
});

const dialect = new PgDialect();

const WORLD_ORG = "org-invite";
const WORLD_CHANNEL = 4;
const ADMIN_USER = "user-admin";
const ADMIN_MEMBERSHIP = 100;
const JOINER_A = "user-a";
const JOINER_A_MEMBERSHIP = 101;
const JOINER_B = "user-b";
const JOINER_B_MEMBERSHIP = 102;

const WORLD_MEMBERSHIPS = new Map<string, number>([
  [ADMIN_USER, ADMIN_MEMBERSHIP],
  [JOINER_A, JOINER_A_MEMBERSHIP],
  [JOINER_B, JOINER_B_MEMBERSHIP],
]);

interface LinkRow {
  id: number;
  channelId: number;
  tokenHash: string | null;
  token: string | null;
  tokenEncrypted: string | null;
  expiresAt: Date | null;
  maxUses: number | null;
  useCount: number;
  revokedAt: Date | null;
}

function renderedParams(where: SQL): { text: string; params: unknown[] } {
  const { sql: text, params } = dialect.sqlToQuery(where);
  return { text, params };
}

function admitsLink(where: SQL, link: LinkRow, now: number): boolean {
  const { text, params } = renderedParams(where);
  if (/"org_id"\s*=\s*\$/i.test(text) && !params.includes(WORLD_ORG)) return false;
  if (/"revoked_at"\s+IS\s+NULL/i.test(text) && link.revokedAt !== null) return false;
  if (/"expires_at"\s+IS\s+NULL\s+OR\s+.*now\(\)/i.test(text))
    if (link.expiresAt !== null && link.expiresAt.getTime() <= now) return false;
  if (/"max_uses"\s+IS\s+NULL\s+OR\s+.*"use_count"\s*<\s*.*"max_uses"/i.test(text))
    if (link.maxUses !== null && link.useCount >= link.maxUses) return false;
  if (/"token_hash"\s*=\s*\$/i.test(text) && !params.includes(link.tokenHash)) return false;
  if (/"chat_channel_invite_links"\."id"\s*=\s*\$/i.test(text) && !params.includes(link.id)) return false;
  return true;
}

function boundMembershipId(where: SQL): number | undefined {
  const { text, params } = renderedParams(where);
  const match = /"chat_channel_members"\."membership_id"\s*=\s*\$(\d+)/i.exec(text);
  if (!match?.[1]) return undefined;
  const value = params[Number(match[1]) - 1];
  return typeof value === "number" ? value : undefined;
}

function boundUserId(where: SQL): string | undefined {
  const { params } = renderedParams(where);
  return params.find(
    (param): param is string => typeof param === "string" && WORLD_MEMBERSHIPS.has(param),
  );
}

function uniqueViolation(): Error {
  const driver = Object.assign(
    new Error("duplicate key value violates unique constraint"),
    {
      code: "23505",
      constraint_name: "uniq_chat_channel_member_membership",
      table_name: "chat_channel_members",
    },
  );
  return Object.assign(new Error("Failed query: insert into chat_channel_members"), { cause: driver });
}

interface InviteWorld {
  service: ChatInviteLinksService;
  links: LinkRow[];
  members: Set<number>;
  memberInsertsOutsideTransaction: () => number;
  memberInsertAttempts: () => number;
}

async function buildInviteWorld(): Promise<InviteWorld> {
  const links: LinkRow[] = [];
  const members = new Set<number>([ADMIN_MEMBERSHIP]);
  const uncommittedMembers = new Set<number>();
  const memberAttempts: unknown[] = [];
  const outsideTransaction: unknown[] = [];
  let nextLinkId = 70;

  const insertMember =
    (pending: number[], outside: boolean) => (values: { membershipId: number }) => {
      memberAttempts.push(values);
      if (outside) outsideTransaction.push(values);
      let conflictTolerated = false;
      const run = () => {
        const duplicate =
          members.has(values.membershipId) || uncommittedMembers.has(values.membershipId);
        if (duplicate) {
          if (!conflictTolerated) throw uniqueViolation();
          return [];
        }
        uncommittedMembers.add(values.membershipId);
        pending.push(values.membershipId);
        return [{ id: 900 + values.membershipId }];
      };
      const node = {
        onConflictDoNothing: () => {
          conflictTolerated = true;
          return node;
        },
        returning: () => Promise.resolve().then(run),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          void Promise.resolve().then(run).then(resolve, reject);
        },
      };
      return node;
    };

  const insertLink = (values: Record<string, unknown>) => {
    const created: LinkRow = {
      id: nextLinkId++,
      channelId: WORLD_CHANNEL,
      tokenHash: typeof values["tokenHash"] === "string" ? values["tokenHash"] : null,
      token: null,
      tokenEncrypted: typeof values["tokenEncrypted"] === "string" ? values["tokenEncrypted"] : null,
      expiresAt: values["expiresAt"] instanceof Date ? values["expiresAt"] : null,
      maxUses: typeof values["maxUses"] === "number" ? values["maxUses"] : null,
      useCount: 0,
      revokedAt: null,
    };
    links.push(created);
    const result = [{ id: created.id }];
    const node = {
      onConflictDoNothing: () => node,
      returning: () => Promise.resolve(result),
      then: (resolve: (value: unknown) => unknown) => {
        void Promise.resolve().then(() => resolve(undefined));
      },
    };
    return node;
  };

  const insert = (pending: number[], outside: boolean) => (table: unknown) => ({
    values: (values: Record<string, unknown>) =>
      table === chatChannelMembers
        ? insertMember(pending, outside)({ membershipId: Number(values["membershipId"]) })
        : insertLink(values),
  });

  const update = (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: (predicate: SQL) => {
        const now = Date.now();
        const claimed: LinkRow[] = [];
        if (table === chatChannelInviteLinks)
          for (const link of links) {
            if (!admitsLink(predicate, link, now)) continue;
            if (values["useCount"] !== undefined) {
              link.useCount += 1;
              claimed.push(link);
              continue;
            }
            if (values["revokedAt"] instanceof Date) link.revokedAt = values["revokedAt"];
            claimed.push(link);
          }
        return Object.assign(Promise.resolve(undefined), {
          returning: () => Promise.resolve(claimed.map((link) => ({ id: link.id }))),
        });
      },
    }),
  });

  const query = {
    chatChannels: {
      findFirst: jest.fn().mockResolvedValue({ id: WORLD_CHANNEL, orgId: WORLD_ORG, isArchived: false }),
    },
    organizationMembers: {
      findFirst: jest.fn(({ where }: { where?: SQL }) => {
        const userId = where ? boundUserId(where) : undefined;
        const membershipId = userId ? WORLD_MEMBERSHIPS.get(userId) : undefined;
        return Promise.resolve(membershipId === undefined ? undefined : { id: membershipId });
      }),
    },
    chatChannelMembers: {
      findFirst: jest.fn(({ where }: { where?: SQL }) => {
        const membershipId = where ? boundMembershipId(where) : undefined;
        if (membershipId === undefined || !members.has(membershipId)) return Promise.resolve(undefined);
        return Promise.resolve({
          id: 900 + membershipId,
          orgId: WORLD_ORG,
          membershipId,
          role: membershipId === ADMIN_MEMBERSHIP ? "ADMIN" : "MEMBER",
        });
      }),
    },
    chatChannelInviteLinks: {
      findFirst: jest.fn(({ where }: { where?: SQL }) => {
        if (!where) throw new Error("an invite link lookup ran with no predicate");
        const now = Date.now();
        return Promise.resolve(links.find((link) => admitsLink(where, link, now)));
      }),
    },
  };

  const db = {
    query,
    insert: insert([], true),
    update,
    transaction: jest.fn(async (run: (tx: unknown) => Promise<unknown>) => {
      const pending: number[] = [];
      try {
        const result = await run({ query, insert: insert(pending, false), update });
        for (const membershipId of pending) members.add(membershipId);
        return result;
      } finally {
        for (const membershipId of pending) uncommittedMembers.delete(membershipId);
      }
    }),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [ChatInviteLinksService, { provide: DRIZZLE, useValue: db }],
  }).compile();

  return {
    service: module.get(ChatInviteLinksService),
    links,
    members,
    memberInsertsOutsideTransaction: () => outsideTransaction.length,
    memberInsertAttempts: () => memberAttempts.length,
  };
}

function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function joinersIn(world: InviteWorld): number[] {
  return [...world.members].filter((id) => id !== ADMIN_MEMBERSHIP);
}

describe("chat invite link lifecycle — accept, expiry, revoke and the single-use race", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("CONTROL: an uncapped link admits the joiner and records the membership", async () => {
    const world = await buildInviteWorld();
    const { token } = await world.service.getOrCreateInviteLink(WORLD_CHANNEL, ADMIN_USER, WORLD_ORG);

    await expect(world.service.joinViaInviteLink(token, JOINER_A, WORLD_ORG)).resolves.toEqual({
      ok: true,
      channelId: WORLD_CHANNEL,
    });
    expect(joinersIn(world)).toEqual([JOINER_A_MEMBERSHIP]);
    expect(world.links[0]?.useCount).toBe(1);
  });

  it("a single-use link is spent by the first accept and refuses the second person", async () => {
    const world = await buildInviteWorld();
    const { token } = await world.service.getOrCreateInviteLink(WORLD_CHANNEL, ADMIN_USER, WORLD_ORG, {
      maxUses: 1,
    });

    await expect(world.service.joinViaInviteLink(token, JOINER_A, WORLD_ORG)).resolves.toMatchObject({
      ok: true,
    });
    await expect(world.service.joinViaInviteLink(token, JOINER_B, WORLD_ORG)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(world.members.has(JOINER_B_MEMBERSHIP)).toBe(false);
    expect(world.links[0]?.useCount).toBe(1);
  });

  it("a regenerated link revokes the old token, which then admits nobody while the new one does", async () => {
    const world = await buildInviteWorld();
    const first = await world.service.getOrCreateInviteLink(WORLD_CHANNEL, ADMIN_USER, WORLD_ORG);
    const second = await world.service.regenerateInviteLink(WORLD_CHANNEL, ADMIN_USER, WORLD_ORG);

    expect(second.token).not.toBe(first.token);
    expect(
      world.links.find((link) => link.tokenHash === sha256(first.token))?.revokedAt,
    ).toBeInstanceOf(Date);

    await expect(
      world.service.joinViaInviteLink(first.token, JOINER_A, WORLD_ORG),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(joinersIn(world)).toEqual([]);

    await expect(
      world.service.joinViaInviteLink(second.token, JOINER_A, WORLD_ORG),
    ).resolves.toMatchObject({ ok: true });
    expect(joinersIn(world)).toEqual([JOINER_A_MEMBERSHIP]);
  });

  it("an expired link admits nobody once its TTL has passed", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-13T10:00:00.000Z"));
    const world = await buildInviteWorld();
    const { token } = await world.service.getOrCreateInviteLink(WORLD_CHANNEL, ADMIN_USER, WORLD_ORG, {
      ttlSeconds: 3600,
    });

    await expect(world.service.joinViaInviteLink(token, JOINER_A, WORLD_ORG)).resolves.toMatchObject({
      ok: true,
    });

    jest.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));
    await expect(world.service.joinViaInviteLink(token, JOINER_B, WORLD_ORG)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(world.members.has(JOINER_B_MEMBERSHIP)).toBe(false);
  });

  it("two concurrent accepts of a single-use link admit exactly one person", async () => {
    const world = await buildInviteWorld();
    const { token } = await world.service.getOrCreateInviteLink(WORLD_CHANNEL, ADMIN_USER, WORLD_ORG, {
      maxUses: 1,
    });

    const outcomes = await Promise.allSettled([
      world.service.joinViaInviteLink(token, JOINER_A, WORLD_ORG),
      world.service.joinViaInviteLink(token, JOINER_B, WORLD_ORG),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const refused = outcomes.find((outcome) => outcome.status === "rejected");
    expect(refused?.status === "rejected" ? refused.reason : undefined).toBeInstanceOf(
      NotFoundException,
    );
    expect(world.links[0]?.useCount).toBe(1);
    expect(joinersIn(world)).toHaveLength(1);
  });

  it("the losing accept issued its membership insert inside its transaction, so the refusal discards it", async () => {
    const world = await buildInviteWorld();
    const { token } = await world.service.getOrCreateInviteLink(WORLD_CHANNEL, ADMIN_USER, WORLD_ORG, {
      maxUses: 1,
    });

    await Promise.allSettled([
      world.service.joinViaInviteLink(token, JOINER_A, WORLD_ORG),
      world.service.joinViaInviteLink(token, JOINER_B, WORLD_ORG),
    ]);

    expect(world.memberInsertAttempts()).toBe(2);
    expect(world.memberInsertsOutsideTransaction()).toBe(0);
    expect(joinersIn(world)).toHaveLength(1);
  });

  it("two concurrent accepts by the SAME person both answer ok and consume one use", async () => {
    const world = await buildInviteWorld();
    const { token } = await world.service.getOrCreateInviteLink(WORLD_CHANNEL, ADMIN_USER, WORLD_ORG, {
      maxUses: 5,
    });

    const outcomes = await Promise.allSettled([
      world.service.joinViaInviteLink(token, JOINER_A, WORLD_ORG),
      world.service.joinViaInviteLink(token, JOINER_A, WORLD_ORG),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(joinersIn(world)).toEqual([JOINER_A_MEMBERSHIP]);
    expect(world.links[0]?.useCount).toBe(1);
  });

  it("an already-joined member re-using the link consumes no further use", async () => {
    const world = await buildInviteWorld();
    const { token } = await world.service.getOrCreateInviteLink(WORLD_CHANNEL, ADMIN_USER, WORLD_ORG, {
      maxUses: 2,
    });

    await world.service.joinViaInviteLink(token, JOINER_A, WORLD_ORG);
    await expect(world.service.joinViaInviteLink(token, JOINER_A, WORLD_ORG)).resolves.toMatchObject({
      ok: true,
    });

    expect(world.links[0]?.useCount).toBe(1);
  });
});
