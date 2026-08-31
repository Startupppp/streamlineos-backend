import { ForbiddenException, Inject, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  chatChannelMembers,
  chatChannels,
  chatMessages,
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { CacheService } from "../../common/cache/cache.service";
import { logger } from "../../common/logger/logger.service";
import type { CreateChannelInput } from "./dto/chat.schemas";
import { assertUsersInOrg } from "../../common/tenant/org-membership";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import { resolvePeopleIdentities, subjectKey } from "../directory/person-seam";

export function entityChannelFallbackName(
  entityType: string,
  entityId: string,
): string {
  return `${entityType.charAt(0).toUpperCase() + entityType.slice(1)}: ${entityId}`;
}

@Injectable()
export class ChatChannelsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly planLimits: PlanLimitsService,
    private readonly cache: CacheService,
    private readonly entities: EntityReferenceService,
  ) {}

  private async membershipId(orgId: string, userId: string): Promise<number | null> {
    const row = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    return row?.id ?? null;
  }

  private async resolveEntityChannelDisplayName<
    T extends {
      id: number;
      name: string;
      entityType: string | null;
      entityId: string | null;
    },
  >(channel: T, actor: EntityActor): Promise<T> {
    if (!channel.entityType || !channel.entityId) return channel;

    const [resolution] = await this.entities.resolve(actor, [
      { type: channel.entityType, id: channel.entityId },
    ]);
    if (resolution?.status !== "resolved") return channel;

    const resolved = resolution.card.title;
    if (channel.name === resolved) return channel;
    if (
      channel.name !==
      entityChannelFallbackName(channel.entityType, channel.entityId)
    ) {
      return channel;
    }

    return { ...channel, name: resolved };
  }

  private async ensureEntityChannelDisplayName<
    T extends {
      id: number;
      name: string;
      entityType: string | null;
      entityId: string | null;
    },
  >(channel: T, actor: EntityActor): Promise<T> {
    const named = await this.resolveEntityChannelDisplayName(channel, actor);
    if (named.name === channel.name) return named;

    await this.db
      .update(chatChannels)
      .set({ name: named.name })
      .where(and(eq(chatChannels.id, channel.id), eq(chatChannels.orgId, actor.orgId)));

    return named;
  }

  async reconcileEntityChannelDisplayName(channelId: number, actor: EntityActor): Promise<void> {
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, actor.orgId)),
      columns: { id: true, name: true, entityType: true, entityId: true },
    });
    if (!channel || !channel.entityType || !channel.entityId) return;
    await this.ensureEntityChannelDisplayName(channel, actor);
  }

  async listMemberChannelIds(orgId: string, userId: string): Promise<number[]> {
    const membershipId = await this.membershipId(orgId, userId);
    if (membershipId === null) return [];
    const rows = await this.db
      .select({ channelId: chatChannels.id })
      .from(chatChannelMembers)
      .innerJoin(chatChannels, eq(chatChannels.id, chatChannelMembers.channelId))
      .where(
        and(
          eq(chatChannels.orgId, orgId),
          eq(chatChannelMembers.membershipId, membershipId),
          eq(chatChannels.isArchived, false),
        ),
      );
    return rows.map((row) => row.channelId);
  }

  async getMyChannels(actor: EntityActor) {
    return this.listMemberChannels(actor, false);
  }

  async getArchivedChannels(actor: EntityActor) {
    return this.listMemberChannels(actor, true);
  }

  private async listMemberChannels(actor: EntityActor, archived: boolean) {
    const { orgId } = actor;
    if (!actor.membershipId) return [];
    const actorMembershipId = actor.membershipId;
    try {
      const memberships = await this.db
        .select({ channelId: chatChannelMembers.channelId })
        .from(chatChannelMembers)
        .where(
          and(
            eq(chatChannelMembers.orgId, orgId),
            eq(chatChannelMembers.membershipId, actor.membershipId),
            archived ? isNotNull(chatChannelMembers.archivedAt) : isNull(chatChannelMembers.archivedAt),
          ),
        );

      if (memberships.length === 0) return [];

      const channelIds = memberships.map((m) => m.channelId);

      const channels = await this.db.query.chatChannels.findMany({
        where: and(
          eq(chatChannels.orgId, orgId),
          inArray(chatChannels.id, channelIds),
          eq(chatChannels.isArchived, false),
        ),
        orderBy: [desc(chatChannels.lastMessageAt)],
        limit: 100,
        with: {
          members: {
            with: { membership: { columns: { id: true, userId: true }, with: { user: { columns: { id: true, name: true, image: true } } } } },
          },
        },
      });

      const unreadRows = await this.cache.cachedVersioned(
        `chat:unread:${orgId}`,
        actor.userId,
        () =>
          this.db
            .select({ channelId: chatMessages.channelId, count: count() })
            .from(chatMessages)
            .innerJoin(
              chatChannelMembers,
              and(
                eq(chatChannelMembers.channelId, chatMessages.channelId),
                eq(chatChannelMembers.membershipId, actorMembershipId),
              ),
            )
            .where(
              and(
                inArray(chatMessages.channelId, channelIds),
                eq(chatMessages.isDeleted, false),
                gt(chatMessages.createdAt, chatChannelMembers.lastReadAt),
              ),
            )
            .groupBy(chatMessages.channelId),
        15,
      );

      const unreadMap = new Map(unreadRows.map((r) => [r.channelId, r.count]));

      const lastMessageRows = await this.db
        .selectDistinctOn([chatMessages.channelId], {
          channelId: chatMessages.channelId,
          content: chatMessages.content,
          senderUserId: organizationMembers.userId,
          createdAt: chatMessages.createdAt,
        })
        .from(chatMessages)
        .leftJoin(organizationMembers, eq(organizationMembers.id, chatMessages.senderMembershipId))
        .where(
          and(inArray(chatMessages.channelId, channelIds), eq(chatMessages.isDeleted, false)),
        )
        .orderBy(chatMessages.channelId, desc(chatMessages.createdAt));

      const lastMsgSenderIds = [...new Set(lastMessageRows.map((r) => r.senderUserId).filter((id): id is string => id !== null))];
      const senderIdentities = await resolvePeopleIdentities(
        this.db,
        orgId,
        lastMsgSenderIds.map((uid) => ({ kind: "user" as const, userId: uid })),
      );

      const lastMsgMap = new Map(
        lastMessageRows.map((r) => {
          const identity = r.senderUserId ? senderIdentities.get(subjectKey({ kind: "user", userId: r.senderUserId })) : undefined;
          const parts = [identity?.firstName, identity?.lastName].filter(Boolean).join(" ");
          const senderName = identity?.displayName ?? (parts || null);
          return [r.channelId, { content: r.content, senderName, createdAt: r.createdAt }];
        }),
      );

      const resolutions = await Promise.allSettled(
        channels.map((ch) => this.resolveEntityChannelDisplayName(ch, actor)),
      );
      const enrichedChannels = channels.map((ch, i) => {
        const r = resolutions[i];
        return r !== undefined && r.status === "fulfilled" ? r.value : ch;
      });

      return enrichedChannels.map((ch) => ({
        ...ch,
        unreadCount: unreadMap.get(ch.id) ?? 0,
        lastMessage: lastMsgMap.get(ch.id) ?? null,
      }));
    } catch (error) {
      logger.error(archived ? "[chat.getArchivedChannels]" : "[chat.getMyChannels]", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw new InternalServerErrorException("Failed to load channels");
    }
  }

  async listPublicChannels(orgId: string, userId: string) {
    const currentMembershipId = await this.membershipId(orgId, userId);
    if (currentMembershipId === null) return [];
    const publicChannels = await this.db.query.chatChannels.findMany({
      where: and(
        eq(chatChannels.orgId, orgId),
        eq(chatChannels.type, "PUBLIC"),
        eq(chatChannels.isArchived, false),
      ),
      orderBy: [desc(chatChannels.lastMessageAt)],
      limit: 100,
      with: {
        members: {
          columns: { membershipId: true },
        },
      },
    });

    return publicChannels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      description: ch.description,
      avatarUrl: ch.avatarUrl,
      type: ch.type,
      memberCount: ch.members.length,
      isMember: ch.members.some((m) => m.membershipId === currentMembershipId),
      createdAt: ch.createdAt,
      lastMessageAt: ch.lastMessageAt,
    }));
  }

  async createChannel(orgId: string, userId: string, body: CreateChannelInput) {
    const creatorMembershipId = await this.membershipId(orgId, userId);
    if (creatorMembershipId === null) throw new NotFoundException("Organization membership not found");
    if (body.type === "DIRECT") {
      const { targetUserId } = body;
      const isSelfDm = targetUserId === userId;
      await assertUsersInOrg(this.db, orgId, [targetUserId]);

      const targetMembershipId = isSelfDm
        ? creatorMembershipId
        : (await this.membershipId(orgId, targetUserId));
      if (targetMembershipId === null) throw new NotFoundException("User not found in this organization");

      const myMemberships = await this.db
        .select({ channelId: chatChannelMembers.channelId })
        .from(chatChannelMembers)
        .where(and(eq(chatChannelMembers.orgId, orgId), eq(chatChannelMembers.membershipId, creatorMembershipId)));

      if (myMemberships.length > 0) {
        const channelIds = myMemberships.map((c) => c.channelId);
        const existingDMs = await this.db.query.chatChannels.findMany({
          where: and(
            inArray(chatChannels.id, channelIds),
            eq(chatChannels.type, "DIRECT"),
            eq(chatChannels.orgId, orgId),
          ),
          with: { members: { columns: { membershipId: true } } },
        });

        const dmChannel = existingDMs.find((ch) =>
          isSelfDm
            ? ch.members.length === 1 && ch.members[0]?.membershipId === creatorMembershipId
            : ch.members.length === 2 &&
              ch.members.some((m) => m.membershipId === targetMembershipId),
        );

        if (dmChannel) return { channel: dmChannel, created: false };
      }

      const [targetUser, currentUser] = await Promise.all([
        this.db.query.users.findFirst({
          where: eq(users.id, targetUserId),
          columns: { name: true },
        }),
        this.db.query.users.findFirst({
          where: eq(users.id, userId),
          columns: { name: true },
        }),
      ]);
      const channel = await this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(chatChannels)
          .values({
            orgId,
            name: isSelfDm
              ? (currentUser?.name ?? "You")
              : `${currentUser?.name ?? "User"} & ${targetUser?.name ?? "User"}`,
            type: "DIRECT",
            createdByMembershipId: creatorMembershipId,
          })
          .returning();

        await tx.insert(chatChannelMembers).values(
          isSelfDm
            ? [{ orgId, channelId: created.id, membershipId: creatorMembershipId, role: "MEMBER" }]
            : [
                { orgId, channelId: created.id, membershipId: creatorMembershipId, role: "MEMBER" },
                { orgId, channelId: created.id, membershipId: targetMembershipId, role: "MEMBER" },
              ],
        );

        return created;
      });

      return { channel, created: true };
    }

    const { name, description, avatarUrl, memberIds, entityType, entityId } = body;
    const allMembers = [...new Set([userId, ...memberIds])];
    const memberRows = await this.db
      .select({ userId: organizationMembers.userId, membershipId: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.status, "ACTIVE"), inArray(organizationMembers.userId, allMembers)));
    const membershipByUser = new Map(memberRows.map((row) => [row.userId, row.membershipId]));
    if (allMembers.some((id) => !membershipByUser.has(id))) throw new NotFoundException("User not found in this organization");
    const channelType = body.type;
    const isPrivate = channelType === "PRIVATE";

    if (!entityType) {
      await this.planLimits.assertWithinLimit(orgId, "chatChannels");
    }

    const channel = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(chatChannels)
        .values({
          orgId,
          name,
          type: channelType,
          description,
          avatarUrl,
          createdByMembershipId: creatorMembershipId,
          isPrivate,
          ...(entityType ? { entityType } : {}),
          ...(entityId ? { entityId } : {}),
        })
        .returning();

      await tx.insert(chatChannelMembers).values(
        allMembers.map((uid) => ({
          orgId,
          channelId: created.id,
          membershipId: membershipByUser.get(uid)!,
          role: uid === userId ? "ADMIN" : "MEMBER",
        })),
      );

      return created;
    });

    return { channel, created: true };
  }

  /**
   * Opening a record's channel is a read of the record, so it resolves through
   * the entity seam first. An unresolvable reference — missing, deleted, another
   * tenant's, or one the caller may not read — is indistinguishable, and none of
   * them reach the channel tables.
   */
  async getOrCreateEntityChannel(
    entityType: string,
    entityId: string,
    actor: EntityActor,
  ) {
    const reference = { type: entityType, id: entityId };
    const [resolution] = await this.entities.resolve(actor, [reference]);
    if (resolution?.status !== "resolved")
      throw new NotFoundException("Record not found");

    const existing = await this.db.query.chatChannels.findFirst({
      where: and(
        eq(chatChannels.entityType, entityType),
        eq(chatChannels.entityId, entityId),
        eq(chatChannels.orgId, actor.orgId),
      ),
      with: {
        members: {
          with: { membership: { columns: { id: true, userId: true }, with: { user: { columns: { id: true, name: true, image: true } } } } },
        },
      },
    });

    if (existing) return this.resolveEntityChannelDisplayName(existing, actor);

    const actorMembershipId = actor.membershipId;
    if (!actorMembershipId) throw new ForbiddenException("Membership required to create a channel");

    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(chatChannels)
        .values({
          orgId: actor.orgId,
          name: resolution.card.title,
          type: "GROUP",
          createdByMembershipId: actorMembershipId,
          entityType,
          entityId,
        })
        .returning();

      if (!created) {
        throw new Error("Failed to create channel");
      }

      await tx.insert(chatChannelMembers).values({
        orgId: actor.orgId,
        channelId: created.id,
        membershipId: actorMembershipId,
        role: "ADMIN",
        notificationPreference: "DEFAULT",
      });

      return created;
    });
  }
}
