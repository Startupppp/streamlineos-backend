import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { EngagementMoodPollsService } from "./engagement-mood-polls.service";
import { EngagementCommunitiesCampaignsService } from "./engagement-communities-campaigns.service";
import {
  createCampaignSchema,
  createCommunitySchema,
  communityListSchema,
  createPollSchema,
  moodCheckinSchema,
  updateCampaignSchema,
  updatePollSchema,
  votePollSchema,
  type CreateCampaignInput,
  type CreateCommunityInput,
  type CommunityListInput,
  type CreatePollInput,
  type MoodCheckinInput,
  type UpdateCampaignInput,
  type UpdatePollInput,
  type VotePollInput,
} from "./dto/engagement-extras.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts";
import { moodCheckinResponseSchema, myMoodHistoryResponseSchema, orgMoodAggregateResponseSchema, listPollsResponseSchema, createPollResponseSchema, updatePollResponseSchema, votePollResponseSchema, pollResultsResponseSchema, listCommunitiesResponseSchema, createCommunityResponseSchema, joinCommunityResponseSchema, leaveCommunityResponseSchema, communityMembersResponseSchema, listCampaignsResponseSchema, createCampaignResponseSchema, updateCampaignResponseSchema } from "./dto/engagement-extras-response.schemas"

const pollIdParams = z
  .object({ pollId: z.coerce.number().int().positive() })
  .strict();
const communityIdParams = z
  .object({ communityId: z.coerce.number().int().positive() })
  .strict();
const campaignIdParams = z
  .object({ campaignId: z.coerce.number().int().positive() })
  .strict();

@RequireModule("hr")
@Controller("hr/engagement")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EngagementExtrasController {
  constructor(
    private readonly moodPolls: EngagementMoodPollsService,
    private readonly communitiesCampaigns: EngagementCommunitiesCampaignsService,
  ) {}

  @ResponseSchema(moodCheckinResponseSchema)
  @Post("mood")
  @RequirePermission("hr:engagement:view")
  @HttpCode(200)
  @Validate({ body: moodCheckinSchema })
  moodCheckin(
    @Body() body: MoodCheckinInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.moodPolls.moodCheckin(u, body);
  }

  @ResponseSchema(myMoodHistoryResponseSchema)
  @Get("mood/history")
  @RequirePermission("hr:engagement:view")
  myMoodHistory(@CurrentUser() u: CurrentUserContext) {
    return this.moodPolls.myMoodHistory(u);
  }

  @ResponseSchema(orgMoodAggregateResponseSchema)
  @Get("mood/aggregate")
  @RequirePermission("hr:engagement:manage")
  orgMoodAggregate(@CurrentUser() u: CurrentUserContext) {
    return this.moodPolls.orgMoodAggregate(u.orgId);
  }

  @ResponseSchema(listPollsResponseSchema)
  @Get("polls")
  @RequirePermission("hr:engagement:view")
  listPolls(@CurrentUser() u: CurrentUserContext) {
    return this.moodPolls.listPolls(u.orgId);
  }

  @ResponseSchema(createPollResponseSchema)
  @Post("polls")
  @RequirePermission("hr:engagement:manage")
  @HttpCode(201)
  @Validate({ body: createPollSchema })
  createPoll(
    @Body() body: CreatePollInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.moodPolls.createPoll(u.orgId, u.userId, body);
  }

  @ResponseSchema(updatePollResponseSchema)
  @Patch("polls/:pollId")
  @RequirePermission("hr:engagement:manage")
  @Validate({ params: pollIdParams, body: updatePollSchema })
  updatePoll(
    @Param("pollId", ParseIntPipe) pollId: number,
    @Body() body: UpdatePollInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.moodPolls.updatePoll(u.orgId, pollId, body);
  }

  @ResponseSchema(votePollResponseSchema)
  @Post("polls/:pollId/vote")
  @RequirePermission("hr:engagement:view")
  @HttpCode(200)
  @Validate({ params: pollIdParams, body: votePollSchema })
  votePoll(
    @Param("pollId", ParseIntPipe) pollId: number,
    @Body() body: VotePollInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.moodPolls.votePoll(u.orgId, u.userId, pollId, body);
  }

  @ResponseSchema(pollResultsResponseSchema)
  @Get("polls/:pollId/results")
  @RequirePermission("hr:engagement:view")
  @Validate({ params: pollIdParams })
  pollResults(
    @Param("pollId", ParseIntPipe) pollId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.moodPolls.pollResults(u.orgId, pollId);
  }

  @ResponseSchema(listCommunitiesResponseSchema)
  @Get("communities")
  @RequirePermission("hr:engagement:view")
  @Validate({ query: communityListSchema })
  listCommunities(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: CommunityListInput,
  ) {
    return this.communitiesCampaigns.listCommunities(u.orgId, query);
  }

  @ResponseSchema(createCommunityResponseSchema)
  @Post("communities")
  @RequirePermission("hr:engagement:view")
  @HttpCode(201)
  @Validate({ body: createCommunitySchema })
  createCommunity(
    @Body() body: CreateCommunityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.communitiesCampaigns.createCommunity(u.orgId, u.userId, body);
  }

  @ResponseSchema(joinCommunityResponseSchema)
  @Post("communities/:communityId/join")
  @BodylessAction()
  @RequirePermission("hr:engagement:view")
  @HttpCode(200)
  @Validate({ params: communityIdParams })
  joinCommunity(
    @Param("communityId", ParseIntPipe) communityId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.communitiesCampaigns.joinCommunity(
      u.orgId,
      u.userId,
      communityId,
    );
  }

  @ResponseSchema(leaveCommunityResponseSchema)
  @Post("communities/:communityId/leave")
  @BodylessAction()
  @RequirePermission("hr:engagement:view")
  @HttpCode(200)
  @Validate({ params: communityIdParams })
  leaveCommunity(
    @Param("communityId", ParseIntPipe) communityId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.communitiesCampaigns.leaveCommunity(
      u.orgId,
      u.userId,
      communityId,
    );
  }

  @ResponseSchema(communityMembersResponseSchema)
  @Get("communities/:communityId/members")
  @RequirePermission("hr:engagement:view")
  @Validate({ params: communityIdParams })
  communityMembers(
    @Param("communityId", ParseIntPipe) communityId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.communitiesCampaigns.communityMembers(u.orgId, communityId);
  }

  @ResponseSchema(listCampaignsResponseSchema)
  @Get("campaigns")
  @RequirePermission("hr:engagement:view")
  listCampaigns(@CurrentUser() u: CurrentUserContext) {
    return this.communitiesCampaigns.listCampaigns(u.orgId);
  }

  @ResponseSchema(createCampaignResponseSchema)
  @Post("campaigns")
  @RequirePermission("hr:engagement:manage")
  @HttpCode(201)
  @Validate({ body: createCampaignSchema })
  createCampaign(
    @Body() body: CreateCampaignInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.communitiesCampaigns.createCampaign(u.orgId, u.userId, body);
  }

  @ResponseSchema(updateCampaignResponseSchema)
  @Patch("campaigns/:campaignId")
  @RequirePermission("hr:engagement:manage")
  @Validate({ params: campaignIdParams, body: updateCampaignSchema })
  updateCampaign(
    @Param("campaignId", ParseIntPipe) campaignId: number,
    @Body() body: UpdateCampaignInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.communitiesCampaigns.updateCampaign(u.orgId, campaignId, body);
  }

  @NoContentResponse()
  @Delete("campaigns/:campaignId")
  @HttpCode(204)
  @RequirePermission("hr:engagement:manage")
  @Validate({ params: campaignIdParams })
  async deleteCampaign(
    @Param("campaignId", ParseIntPipe) campaignId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.communitiesCampaigns.deleteCampaign(u.orgId, campaignId);
  }
}
