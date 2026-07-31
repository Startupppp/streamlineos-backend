import { Injectable } from "@nestjs/common";
import { EngagementMoodPollsService } from "./engagement-mood-polls.service";
import { EngagementBadgesService } from "./engagement-badges.service";
import { EngagementCommunitiesCampaignsService } from "./engagement-communities-campaigns.service";
import type {
  AwardBadgeInput,
  CreateBadgeInput,
  CreateCampaignInput,
  CreateCommunityInput,
  CreatePollInput,
  MoodCheckinInput,
  UpdateCampaignInput,
  UpdatePollInput,
  VotePollInput,
} from "./dto/engagement-extras.schemas";

@Injectable()
export class EngagementExtrasService {
  constructor(
    private readonly moodPolls: EngagementMoodPollsService,
    private readonly badges: EngagementBadgesService,
    private readonly communitiesCampaigns: EngagementCommunitiesCampaignsService,
  ) {}

  moodCheckin(orgId: string, userId: string, input: MoodCheckinInput) {
    return this.moodPolls.moodCheckin(orgId, userId, input);
  }

  myMoodHistory(orgId: string, userId: string, limit?: number) {
    return this.moodPolls.myMoodHistory(orgId, userId, limit);
  }

  orgMoodAggregate(orgId: string) {
    return this.moodPolls.orgMoodAggregate(orgId);
  }

  listBadges(orgId: string) {
    return this.badges.listBadges(orgId);
  }

  createBadge(orgId: string, input: CreateBadgeInput) {
    return this.badges.createBadge(orgId, input);
  }

  deleteBadge(orgId: string, badgeId: number) {
    return this.badges.deleteBadge(orgId, badgeId);
  }

  awardBadge(orgId: string, awardedBy: string, badgeId: number, input: AwardBadgeInput) {
    return this.badges.awardBadge(orgId, awardedBy, badgeId, input);
  }

  myBadges(orgId: string, userId: string) {
    return this.badges.myBadges(orgId, userId);
  }

  myPoints(orgId: string, userId: string) {
    return this.badges.myPoints(orgId, userId);
  }

  leaderboard(orgId: string, topN?: number) {
    return this.badges.leaderboard(orgId, topN);
  }

  listPolls(orgId: string) {
    return this.moodPolls.listPolls(orgId);
  }

  createPoll(orgId: string, userId: string, input: CreatePollInput) {
    return this.moodPolls.createPoll(orgId, userId, input);
  }

  updatePoll(orgId: string, pollId: number, input: UpdatePollInput) {
    return this.moodPolls.updatePoll(orgId, pollId, input);
  }

  votePoll(orgId: string, userId: string, pollId: number, input: VotePollInput) {
    return this.moodPolls.votePoll(orgId, userId, pollId, input);
  }

  pollResults(orgId: string, pollId: number) {
    return this.moodPolls.pollResults(orgId, pollId);
  }

  listCommunities(orgId: string) {
    return this.communitiesCampaigns.listCommunities(orgId);
  }

  createCommunity(orgId: string, userId: string, input: CreateCommunityInput) {
    return this.communitiesCampaigns.createCommunity(orgId, userId, input);
  }

  joinCommunity(orgId: string, userId: string, communityId: number) {
    return this.communitiesCampaigns.joinCommunity(orgId, userId, communityId);
  }

  leaveCommunity(orgId: string, userId: string, communityId: number) {
    return this.communitiesCampaigns.leaveCommunity(orgId, userId, communityId);
  }

  communityMembers(orgId: string, communityId: number) {
    return this.communitiesCampaigns.communityMembers(orgId, communityId);
  }

  listCampaigns(orgId: string) {
    return this.communitiesCampaigns.listCampaigns(orgId);
  }

  createCampaign(orgId: string, userId: string, input: CreateCampaignInput) {
    return this.communitiesCampaigns.createCampaign(orgId, userId, input);
  }

  updateCampaign(orgId: string, campaignId: number, input: UpdateCampaignInput) {
    return this.communitiesCampaigns.updateCampaign(orgId, campaignId, input);
  }

  deleteCampaign(orgId: string, campaignId: number) {
    return this.communitiesCampaigns.deleteCampaign(orgId, campaignId);
  }

  employeeOfMonth(orgId: string) {
    return this.badges.employeeOfMonth(orgId);
  }

  grantKudosPoints(orgId: string, userId: string, sourceId: string) {
    return this.badges.grantKudosPoints(orgId, userId, sourceId);
  }
}
