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

    if (existing) return this.listService.resolveEntityChannelDisplayName(existing, actor);

    const actorMembershipId = actor.membershipId;
    if (!actorMembershipId) throw new ForbiddenException("Membership required to create a channel");

    return this.db.transaction(async (tx) => {
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
        .returning();

      await tx.insert(chatChannelMembers).values({
        orgId: actor.orgId,
        channelId: created.id,
        membershipId: actorMembershipId,
        role: "ADMIN",
      });

      return created;
    });
  }
}
