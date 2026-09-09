import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import {
  chatAttachments,
  chatChannelMembers,
  chatChannels,
  chatMessageReactions,
  chatMessages,
  chatReplyReminders,
} from "src/db/schema";
import type { Db } from "src/db/drizzle.module";
import { ORG_MEMBER_ROLES } from "src/common/rbac/org-roles";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

export const CHAT_PERMISSION_KEYS = [
  "chat:channels:read",
  "chat:channels:write",
  "chat:messages:read",
  "chat:messages:write",
] as const;

export type HomeAlias =
  | "owner"
  | "channelAdmin"
  | "channelMember"
  | "outsider"
  | "removed";

export interface ChatWorld {
  readonly seeded: SeededE2eApp;
  readonly server: Server;
  readonly home: SeededFixture;
  readonly neighbour: SeededFixture;
  readonly privateChannelId: number;
  readonly publicChannelId: number;
  readonly removedMembershipRowExisted: boolean;
  readonly strangerToken: string;
  readonly strangerUserId: string;
  tokenFor(alias: HomeAlias): string;
  userIdFor(alias: HomeAlias): string;
  membershipIdFor(alias: HomeAlias): number;
  messageCount(channelId: number): Promise<number>;
  memberCount(channelId: number): Promise<number>;
  close(): Promise<void>;
}

const SETTLE_AFTER_COMMIT_MS = 1_500;

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_AFTER_COMMIT_MS));
}

async function insertChannel(
  db: Db,
  orgId: string,
  name: string,
  type: "PUBLIC" | "PRIVATE",
): Promise<number> {
  const [row] = await db
    .insert(chatChannels)
    .values({ orgId, name, type, isPrivate: type !== "PUBLIC" })
    .returning({ id: chatChannels.id });
  if (!row) throw new Error(`[chat-world] channel "${name}" was not created`);
  return row.id;
}

async function joinChannel(
  db: Db,
  orgId: string,
  channelId: number,
  membershipId: number,
  role: "ADMIN" | "MEMBER",
): Promise<number> {
  const [row] = await db
    .insert(chatChannelMembers)
    .values({ orgId, channelId, membershipId, role })
    .returning({ id: chatChannelMembers.id });
  if (!row)
    throw new Error(`[chat-world] membership ${String(membershipId)} was not created`);
  return row.id;
}

async function purgeChatRows(db: Db, orgId: string): Promise<void> {
  await db.delete(chatMessageReactions).where(eq(chatMessageReactions.orgId, orgId));
  await db.delete(chatAttachments).where(eq(chatAttachments.orgId, orgId));
  await db.delete(chatReplyReminders).where(eq(chatReplyReminders.orgId, orgId));
  await db.delete(chatMessages).where(eq(chatMessages.orgId, orgId));
  await db.delete(chatChannelMembers).where(eq(chatChannelMembers.orgId, orgId));
  await db.delete(chatChannels).where(eq(chatChannels.orgId, orgId));
}

export async function createChatWorld(): Promise<ChatWorld> {
  const seeded = await createSeededE2eApp();
  const db = seeded.seedDb;

  const home = await seedOrg(db)
    .onPlan("PAID")
    .addMember("owner", {
      standing: ORG_MEMBER_ROLES.OWNER,
      permissionKeys: CHAT_PERMISSION_KEYS,
    })
    .addMember("channelAdmin", { permissionKeys: CHAT_PERMISSION_KEYS })
    .addMember("channelMember", { permissionKeys: CHAT_PERMISSION_KEYS })
    .addMember("outsider", { permissionKeys: CHAT_PERMISSION_KEYS })
    .addMember("removed", { permissionKeys: CHAT_PERMISSION_KEYS })
    .build();

  const neighbour = await seedOrg(db)
    .onPlan("PAID")
    .addMember("stranger", { permissionKeys: CHAT_PERMISSION_KEYS })
    .build();

  function requireMember(alias: HomeAlias) {
    const member = home.members[alias];
    if (!member) throw new Error(`[chat-world] alias "${alias}" was not seeded`);
    return member;
  }

  const stranger = neighbour.members["stranger"];
  if (!stranger) throw new Error("[chat-world] neighbour member was not seeded");

  const privateChannelId = await insertChannel(
    db,
    home.orgId,
    "seeded-private-channel",
    "PRIVATE",
  );
  const publicChannelId = await insertChannel(
    db,
    home.orgId,
    "seeded-public-channel",
    "PUBLIC",
  );

  await joinChannel(db, home.orgId, privateChannelId, requireMember("channelAdmin").membershipId, "ADMIN");
  await joinChannel(db, home.orgId, privateChannelId, requireMember("channelMember").membershipId, "MEMBER");
  await joinChannel(db, home.orgId, privateChannelId, requireMember("owner").membershipId, "MEMBER");
  await joinChannel(db, home.orgId, publicChannelId, requireMember("channelAdmin").membershipId, "ADMIN");
  await joinChannel(db, home.orgId, publicChannelId, requireMember("channelMember").membershipId, "MEMBER");

  const removedRowId = await joinChannel(
    db,
    home.orgId,
    privateChannelId,
    requireMember("removed").membershipId,
    "MEMBER",
  );
  await db.delete(chatChannelMembers).where(eq(chatChannelMembers.id, removedRowId));

  const aliases: readonly HomeAlias[] = [
    "owner",
    "channelAdmin",
    "channelMember",
    "outsider",
    "removed",
  ];
  const tokens = new Map<HomeAlias, string>();
  for (const alias of aliases)
    tokens.set(
      alias,
      await signSeededToken(seeded, requireMember(alias).userId, home.orgId),
    );

  const strangerToken = await signSeededToken(seeded, stranger.userId, neighbour.orgId);

  return {
    seeded,
    server: seeded.app.getHttpServer(),
    home,
    neighbour,
    privateChannelId,
    publicChannelId,
    removedMembershipRowExisted: removedRowId > 0,
    strangerToken,
    strangerUserId: stranger.userId,
    tokenFor(alias) {
      const token = tokens.get(alias);
      if (!token) throw new Error(`[chat-world] no token for alias "${alias}"`);
      return token;
    },
    userIdFor(alias) {
      return requireMember(alias).userId;
    },
    membershipIdFor(alias) {
      return requireMember(alias).membershipId;
    },
    async messageCount(channelId) {
      const rows = await db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(eq(chatMessages.channelId, channelId));
      return rows.length;
    },
    async memberCount(channelId) {
      const rows = await db
        .select({ id: chatChannelMembers.id })
        .from(chatChannelMembers)
        .where(eq(chatChannelMembers.channelId, channelId));
      return rows.length;
    },
    async close() {
      await settle();
      await purgeChatRows(db, home.orgId);
      await purgeChatRows(db, neighbour.orgId);
      await home.teardown();
      await neighbour.teardown();
      await seeded.close();
    },
  };
}
