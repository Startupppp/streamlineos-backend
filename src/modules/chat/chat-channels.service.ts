import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { chatChannelMembers, chatChannels, organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { CacheService } from "../../common/cache/cache.service";
import type { CreateChannelInput } from "./dto/chat.schemas";
import { assertUsersInOrg } from "../../common/tenant/org-membership";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import { ChatChannelListService } from "./chat-channel-list.service";
import {
  CHANNEL_MEMBER_COLUMNS,
  CHANNEL_MEMBER_MEMBERSHIP_WITH,
  flattenChannelMember,
} from "./chat-channel-member-shape";
import { CHAT_ENTITY_CHANNEL_CONFLICT } from "./chat-entity-channel-conflict-target";

export { entityChannelFallbackName } from "./chat-channel-list.service";

@Injectable()
export class ChatChannelsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly planLimits: PlanLimitsService,
    private readonly cache: CacheService,
    private readonly entities: EntityReferenceService,
    private readonly listService: ChatChannelListService,
  ) {}

  async getMyChannels(actor: EntityActor, cursor?: string | null, limit?: number) {
    return this.listService.getMyChannels(actor, cursor, limit);
  }

  async getArchivedChannels(actor: EntityActor, cursor?: string | null, limit?: number) {
    return this.listService.getArchivedChannels(actor, cursor, limit);
  }

  async listPublicChannels(orgId: string, userId: string, cursor?: string | null, limit?: number) {
    return this.listService.listPublicChannels(orgId, userId, cursor, limit);
  }

  async listMemberChannelIds(orgId: string, userId: string): Promise<number[]> {
    return this.listService.listMemberChannelIds(orgId, userId);
  }

  private async ensureEntityChannelDisplayName<
    T extends { id: number; name: string; entityType: string | null; entityId: string | null }
  >(channel: T, actor: EntityActor): Promise<T> {
    const named = await this.listService.resolveEntityChannelDisplayName(channel, actor);
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
    if (!channel) throw new NotFoundException("Channel not found");
    if (!channel.entityType || !channel.entityId) return;
    await this.ensureEntityChannelDisplayName(channel, actor);
  }

  async createChannel(orgId: string, userId: string, body: CreateChannelInput) {
    const creatorMembershipId = await this.listService.getMembershipId(orgId, userId);
    if (creatorMembershipId === null) throw new NotFoundException("Organization membership not found");
    if (body.type === "DIRECT") {
      const { targetUserId } = body;
      const isSelfDm = targetUserId === userId;
      await assertUsersInOrg(this.db, orgId, [targetUserId]);

      const targetMembershipId = isSelfDm
        ? creatorMembershipId
        : (await this.listService.getMembershipId(orgId, targetUserId));
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
            isPrivate: true,
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
    // is_private tracks discoverability, not just the PRIVATE label: an invite-only
    // GROUP is no more browsable than a PRIVATE one, and the membership guard reads
    // this column to answer 404 rather than 403.
    const isPrivate = channelType !== "PUBLIC";

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

    const existing = await this.loadEntityChannel(entityType, entityId, actor);
    if (existing) return existing;

    const actorMembershipId = actor.membershipId;
    if (!actorMembershipId) throw new ForbiddenException("Membership required to create a channel");

    // Check-then-insert with nothing behind it produced TWO channels for one record: the
    // only caller is a TanStack `useQuery` (a GET that writes), so a StrictMode
    // double-mount, a second tab or a retry ran two of these concurrently, both missed the
    // findFirst above and both inserted. `idx_chat_channels_org_entity` was a plain index,
    // so nothing refused the second row; `findFirst` then returned whichever the scan
    // reached first and the conversation split between two channels whose members could
    // not see each other.
    //
    // `uniq_chat_channels_org_entity` (migration 1058) is now the arbiter and the loser of
    // the race gets no row back — it re-reads the winner's channel INSIDE the same
    // transaction and returns that, so both callers see one channel and neither 500s.
    const raced = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(chatChannels)
        .values({
          orgId: actor.orgId,
          name: resolution.card.title,
          type: "GROUP",
          isPrivate: true,
          createdByMembershipId: actorMembershipId,
          entityType,
          entityId,
        })
        .onConflictDoNothing(CHAT_ENTITY_CHANNEL_CONFLICT)
        .returning();

      if (!created) return null;

      await tx.insert(chatChannelMembers).values({
        orgId: actor.orgId,
        channelId: created.id,
        membershipId: actorMembershipId,
        role: "ADMIN",
      });

      return created;
    });

    if (raced) return raced;

    const winner = await this.loadEntityChannel(entityType, entityId, actor);
    if (!winner) throw new NotFoundException("Record not found");
    return winner;
  }

  /**
   * The record's channel with its roster, named through the entity seam.
   *
   * Shared by the pre-check and the conflict-loser path so the two return the same shape:
   * the loser of a create race must not get a bare channel row where the winner's peer got
   * one with members on it.
   */
  private async loadEntityChannel(entityType: string, entityId: string, actor: EntityActor) {
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(
        eq(chatChannels.entityType, entityType),
        eq(chatChannels.entityId, entityId),
        eq(chatChannels.orgId, actor.orgId),
      ),
      with: {
        members: {
          columns: CHANNEL_MEMBER_COLUMNS,
          with: { membership: CHANNEL_MEMBER_MEMBERSHIP_WITH },
        },
      },
    });
    if (!channel) return null;
    const named = await this.listService.resolveEntityChannelDisplayName(channel, actor);
    return { ...named, members: named.members.map(flattenChannelMember) };
  }
}
