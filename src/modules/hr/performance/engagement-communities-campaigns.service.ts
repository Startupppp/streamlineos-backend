import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  hrCampaigns,
  hrCommunities,
  hrCommunityMembers,
} from "../../../db/schema/hr/engagement-extras";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type {
  CreateCampaignInput,
  CreateCommunityInput,
  UpdateCampaignInput,
} from "./dto/engagement-extras.schemas";

@Injectable()
export class EngagementCommunitiesCampaignsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listCommunities(orgId: string) {
    const communities = await this.db
      .select()
      .from(hrCommunities)
      .where(eq(hrCommunities.orgId, orgId))
      .orderBy(desc(hrCommunities.createdAt))
      .limit(100);

    if (communities.length === 0) return [];

    const ids = communities.map((c) => c.id);
    const members = await this.db
      .select({
        communityId: hrCommunityMembers.communityId,
        userId: hrCommunityMembers.userId,
        role: hrCommunityMembers.role,
      })
      .from(hrCommunityMembers)
      .where(inArray(hrCommunityMembers.communityId, ids));

    const membersByComm = new Map<number, { userId: string; role: string }[]>();
    for (const m of members) {
      const list = membersByComm.get(m.communityId) ?? [];
      list.push({ userId: m.userId, role: m.role });
      membersByComm.set(m.communityId, list);
    }

    return communities.map((c) => ({
      ...c,
      members: membersByComm.get(c.id) ?? [],
    }));
  }

  async createCommunity(
    orgId: string,
    userId: string,
    input: CreateCommunityInput,
  ) {
    return this.db.transaction(async (tx) => {
      const [community] = await tx
        .insert(hrCommunities)
        .values({
          orgId,
          name: input.name,
          description: input.description ?? null,
          createdBy: userId,
        })
        .returning()
        .catch(() => {
          throw new ConflictException(
            `Community "${input.name}" already exists.`,
          );
        });

      await tx.insert(hrCommunityMembers).values({
        communityId: community.id,
        userId,
        role: "moderator",
      });

      return community;
    });
  }

  async joinCommunity(orgId: string, userId: string, communityId: number) {
    const [community] = await this.db
      .select({ id: hrCommunities.id })
      .from(hrCommunities)
      .where(
        and(eq(hrCommunities.id, communityId), eq(hrCommunities.orgId, orgId)),
      );
    if (!community) throw new NotFoundException("Community not found.");

    await this.db
      .insert(hrCommunityMembers)
      .values({ communityId, userId, role: "member" })
      .catch(() => {
        throw new ConflictException("Already a member.");
      });

    return { success: true };
  }

  async leaveCommunity(orgId: string, userId: string, communityId: number) {
    const [community] = await this.db
      .select({ id: hrCommunities.id })
      .from(hrCommunities)
      .where(
        and(eq(hrCommunities.id, communityId), eq(hrCommunities.orgId, orgId)),
      );
    if (!community) throw new NotFoundException("Community not found.");

    await this.db
      .delete(hrCommunityMembers)
      .where(
        and(
          eq(hrCommunityMembers.communityId, communityId),
          eq(hrCommunityMembers.userId, userId),
        ),
      );
    return { success: true };
  }

  async communityMembers(orgId: string, communityId: number) {
    const [community] = await this.db
      .select()
      .from(hrCommunities)
      .where(
        and(eq(hrCommunities.id, communityId), eq(hrCommunities.orgId, orgId)),
      );
    if (!community) throw new NotFoundException("Community not found.");

    const members = await this.db
      .select({
        userId: hrCommunityMembers.userId,
        role: hrCommunityMembers.role,
      })
      .from(hrCommunityMembers)
      .where(eq(hrCommunityMembers.communityId, communityId));

    return { ...community, members };
  }

  listCampaigns(orgId: string) {
    return this.db
      .select()
      .from(hrCampaigns)
      .where(eq(hrCampaigns.orgId, orgId))
      .orderBy(desc(hrCampaigns.createdAt))
      .limit(100);
  }

  async createCampaign(
    orgId: string,
    userId: string,
    input: CreateCampaignInput,
  ) {
    const [campaign] = await this.db
      .insert(hrCampaigns)
      .values({
        orgId,
        name: input.name,
        description: input.description ?? null,
        startsAt: input.startsAt ? new Date(input.startsAt) : null,
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        status: input.status ?? "draft",
        audience: input.audience ?? null,
        createdBy: userId,
      })
      .returning();
    return campaign;
  }

  async updateCampaign(
    orgId: string,
    campaignId: number,
    input: UpdateCampaignInput,
  ) {
    const [campaign] = await this.db
      .select({ id: hrCampaigns.id })
      .from(hrCampaigns)
      .where(
        and(eq(hrCampaigns.id, campaignId), eq(hrCampaigns.orgId, orgId)),
      );
    if (!campaign) throw new NotFoundException("Campaign not found.");

    const [updated] = await this.db
      .update(hrCampaigns)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.startsAt !== undefined && {
          startsAt: new Date(input.startsAt),
        }),
        ...(input.endsAt !== undefined && { endsAt: new Date(input.endsAt) }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.audience !== undefined && { audience: input.audience }),
      })
      .where(
        and(eq(hrCampaigns.id, campaignId), eq(hrCampaigns.orgId, orgId)),
      )
      .returning();
    return updated;
  }

  async deleteCampaign(orgId: string, campaignId: number) {
    const [campaign] = await this.db
      .select({ id: hrCampaigns.id })
      .from(hrCampaigns)
      .where(
        and(eq(hrCampaigns.id, campaignId), eq(hrCampaigns.orgId, orgId)),
      );
    if (!campaign) throw new NotFoundException("Campaign not found.");

    await this.db
      .delete(hrCampaigns)
      .where(
        and(eq(hrCampaigns.id, campaignId), eq(hrCampaigns.orgId, orgId)),
      );
    return { success: true };
  }
}
