import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { ChatInviteLinksService } from "../chat-invite-links.service";
import { chatChannelInviteLinks } from "../../../db/schema";

const dialect = new PgDialect();

const CHANNEL_ID = 1;
const ORG_ID = "org-expiry";
const USER_ID = "user-expiry";
const LINK_ID = 77;
const MEMBERSHIP_ID = 55;

function makeUpdateChain(returning: Array<{ id: number }> = [{ id: LINK_ID }]) {
  const chain = {
    set: jest.fn().mockReturnThis(),
    where: jest.fn(),
  };
  chain.where.mockReturnValue(
    Object.assign(Promise.resolve(undefined), {
      returning: jest.fn().mockResolvedValue(returning),
    }),
  );
  return chain;
}

function makeInsertChain() {
  return {
    values: jest.fn().mockReturnValue(
      Object.assign(Promise.resolve(undefined), {
        onConflictDoNothing: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: LINK_ID }]),
        }),
        returning: jest.fn().mockResolvedValue([{ id: LINK_ID }]),
      }),
    ),
  };
}

function buildMock() {
  const db = {
    query: {
      chatChannels: { findFirst: jest.fn() },
      chatChannelMembers: { findFirst: jest.fn() },
      chatChannelInviteLinks: { findFirst: jest.fn() },
      organizationMembers: { findFirst: jest.fn() },
    },
    insert: jest.fn().mockReturnValue(makeInsertChain()),
    update: jest.fn().mockReturnValue(makeUpdateChain()),
    transaction: jest.fn().mockImplementation((cb: (tx: typeof db) => unknown) => cb(db)),
  };
  return db;
}

describe("chat invite link SQL predicates — rendered with PgDialect so the DB enforces them", () => {
  let service: ChatInviteLinksService;
  let mockDb: ReturnType<typeof buildMock>;

  beforeEach(async () => {
    mockDb = buildMock();
    mockDb.query.chatChannels.findFirst.mockResolvedValue({ id: CHANNEL_ID, isPrivate: false, entityType: null, entityId: null });
    mockDb.query.organizationMembers.findFirst.mockResolvedValue({ id: MEMBERSHIP_ID });
    const module = await Test.createTestingModule({
      providers: [
        ChatInviteLinksService,
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();
    service = module.get(ChatInviteLinksService);
  });

  describe("joinViaInviteLink — the initial findFirst query", () => {
    function captureInviteLinkWhere(): Promise<SQL> {
      return new Promise((resolve) => {
        mockDb.query.chatChannelInviteLinks.findFirst.mockImplementationOnce(
          (config: { where?: SQL }) => {
            if (config.where) resolve(config.where);
            return Promise.resolve(undefined);
          },
        );
      });
    }

    it("includes an expiry predicate in the emitted SQL so the database rejects stale links", async () => {
      const wherePromise = captureInviteLinkWhere();
      await service.joinViaInviteLink("tok", USER_ID, ORG_ID).catch(() => undefined);
      const where = await wherePromise;
      const { sql: text } = dialect.sqlToQuery(where);
      expect(text).toMatch(/expires_at.*IS NULL/i);
      expect(text).toContain("now()");
    });

    it("the expiry predicate has exactly two alternatives: IS NULL and > now()", async () => {
      const wherePromise = captureInviteLinkWhere();
      await service.joinViaInviteLink("tok", USER_ID, ORG_ID).catch(() => undefined);
      const where = await wherePromise;
      const { sql: text } = dialect.sqlToQuery(where);
      expect(text).toMatch(/\(\s*"chat_channel_invite_links"\."expires_at" IS NULL OR "chat_channel_invite_links"\."expires_at" > now\(\)\s*\)/i);
    });

    it("includes a use-count exhaustion predicate in the emitted SQL", async () => {
      const wherePromise = captureInviteLinkWhere();
      await service.joinViaInviteLink("tok", USER_ID, ORG_ID).catch(() => undefined);
      const where = await wherePromise;
      const { sql: text } = dialect.sqlToQuery(where);
      expect(text).toMatch(/max_uses.*IS NULL/i);
      expect(text).toMatch(/use_count.*<.*max_uses/i);
    });

    it("the exhaustion predicate references both use_count and max_uses columns", async () => {
      const wherePromise = captureInviteLinkWhere();
      await service.joinViaInviteLink("tok", USER_ID, ORG_ID).catch(() => undefined);
      const where = await wherePromise;
      const { sql: text } = dialect.sqlToQuery(where);
      expect(text).toMatch(/\(\s*"chat_channel_invite_links"\."max_uses" IS NULL OR "chat_channel_invite_links"\."use_count" < "chat_channel_invite_links"\."max_uses"\s*\)/i);
    });

    it("also gates on revoked_at IS NULL so a revoked link is never admitted", async () => {
      const wherePromise = captureInviteLinkWhere();
      await service.joinViaInviteLink("tok", USER_ID, ORG_ID).catch(() => undefined);
      const where = await wherePromise;
      const { sql: text } = dialect.sqlToQuery(where);
      expect(text).toMatch(/"chat_channel_invite_links"\."revoked_at" IS NULL/i);
    });
  });

  describe("findActiveLink — the predicate used by getOrCreateInviteLink", () => {
    function captureActiveLinkWhere(): Promise<SQL> {
      return new Promise((resolve) => {
        mockDb.query.chatChannelInviteLinks.findFirst.mockImplementation(
          (config: { where?: SQL }) => {
            if (config.where) resolve(config.where);
            return Promise.resolve(undefined);
          },
        );
      });
    }

    it("treats expired links as inactive so a fresh one is minted instead of an unusable one returned", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ role: "ADMIN", orgId: ORG_ID, membershipId: MEMBERSHIP_ID });
      const wherePromise = captureActiveLinkWhere();
      service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID).catch(() => undefined);
      const where = await wherePromise;
      const { sql: text } = dialect.sqlToQuery(where);
      expect(text).toMatch(/expires_at.*IS NULL/i);
      expect(text).toContain("now()");
    });

    it("treats exhausted links as inactive so a fresh one is minted", async () => {
      mockDb.query.chatChannelMembers.findFirst.mockResolvedValue({ role: "ADMIN", orgId: ORG_ID, membershipId: MEMBERSHIP_ID });
      const wherePromise = captureActiveLinkWhere();
      service.getOrCreateInviteLink(CHANNEL_ID, USER_ID, ORG_ID).catch(() => undefined);
      const where = await wherePromise;
      const { sql: text } = dialect.sqlToQuery(where);
      expect(text).toMatch(/use_count.*<.*max_uses/i);
    });
  });

  describe("the conditions are composable: manual render confirms column binding", () => {
    it("the validLinkCondition uses real column references, not string literals", () => {
      const condition = and(
        isNull(chatChannelInviteLinks.revokedAt),
        sql`(${chatChannelInviteLinks.expiresAt} IS NULL OR ${chatChannelInviteLinks.expiresAt} > now())`,
        sql`(${chatChannelInviteLinks.maxUses} IS NULL OR ${chatChannelInviteLinks.useCount} < ${chatChannelInviteLinks.maxUses})`,
      );
      const { sql: text } = dialect.sqlToQuery(condition!);
      expect(text).toContain('"chat_channel_invite_links"."revoked_at"');
      expect(text).toContain('"chat_channel_invite_links"."expires_at"');
      expect(text).toContain('"chat_channel_invite_links"."max_uses"');
      expect(text).toContain('"chat_channel_invite_links"."use_count"');
    });

    it("the org_id and channel_id bindings emit SQL params, not inlined values", () => {
      const condition = and(
        eq(chatChannelInviteLinks.orgId, ORG_ID),
        eq(chatChannelInviteLinks.channelId, CHANNEL_ID),
        isNull(chatChannelInviteLinks.revokedAt),
        sql`(${chatChannelInviteLinks.expiresAt} IS NULL OR ${chatChannelInviteLinks.expiresAt} > now())`,
        sql`(${chatChannelInviteLinks.maxUses} IS NULL OR ${chatChannelInviteLinks.useCount} < ${chatChannelInviteLinks.maxUses})`,
      );
      const { sql: text, params } = dialect.sqlToQuery(condition!);
      expect(params).toContain(ORG_ID);
      expect(params).toContain(CHANNEL_ID);
      expect(text).not.toContain(ORG_ID);
      expect(text).toMatch(/"org_id" = \$\d+/);
      expect(text).toMatch(/"channel_id" = \$\d+/);
    });
  });
});
