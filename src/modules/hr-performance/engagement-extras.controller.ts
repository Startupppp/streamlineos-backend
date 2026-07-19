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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { EngagementExtrasService } from "./engagement-extras.service";
import {
  awardBadgeSchema,
  createBadgeSchema,
  createCampaignSchema,
  createCommunitySchema,
  createPollSchema,
  moodCheckinSchema,
  updateCampaignSchema,
  updatePollSchema,
  votePollSchema,
  type AwardBadgeInput,
  type CreateBadgeInput,
  type CreateCampaignInput,
  type CreateCommunityInput,
  type CreatePollInput,
  type MoodCheckinInput,
  type UpdateCampaignInput,
  type UpdatePollInput,
  type VotePollInput,
} from "./dto/engagement-extras.schemas";

@RequireModule("hr")
@Controller("hr/engagement")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EngagementExtrasController {
  constructor(private readonly svc: EngagementExtrasService) {}

  @Get("overview")
  @RequirePermission("hr:engagement:view")
  async overview(@CurrentUser() u: CurrentUserContext) {
    const [eom, leaderboard] = await Promise.all([
      this.svc.employeeOfMonth(u.orgId),
      this.svc.leaderboard(u.orgId, 5),
    ]);
    return { employeeOfMonth: eom, topLeaderboard: leaderboard };
  }

  @Post("mood")
  @RequirePermission("hr:engagement:view")
  @HttpCode(200)
  moodCheckin(
    @Body(new ZodValidationPipe(moodCheckinSchema)) body: MoodCheckinInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.moodCheckin(u.orgId, u.userId, body);
  }

  @Get("mood/history")
  @RequirePermission("hr:engagement:view")
  myMoodHistory(@CurrentUser() u: CurrentUserContext) {
    return this.svc.myMoodHistory(u.orgId, u.userId);
  }

  @Get("mood/aggregate")
  @RequirePermission("hr:engagement:manage")
  orgMoodAggregate(@CurrentUser() u: CurrentUserContext) {
    return this.svc.orgMoodAggregate(u.orgId);
  }

  @Get("badges")
  @RequirePermission("hr:engagement:view")
  listBadges(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listBadges(u.orgId);
  }

  @Post("badges")
  @RequirePermission("hr:engagement:manage")
  @HttpCode(201)
  createBadge(
    @Body(new ZodValidationPipe(createBadgeSchema)) body: CreateBadgeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createBadge(u.orgId, body);
  }

  @Delete("badges/:badgeId")
  @HttpCode(204)
  @RequirePermission("hr:engagement:manage")
  async deleteBadge(
    @Param("badgeId", ParseIntPipe) badgeId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.svc.deleteBadge(u.orgId, badgeId);
  }

  @Post("badges/:badgeId/award")
  @RequirePermission("hr:engagement:manage")
  @HttpCode(201)
  awardBadge(
    @Param("badgeId", ParseIntPipe) badgeId: number,
    @Body(new ZodValidationPipe(awardBadgeSchema)) body: AwardBadgeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.awardBadge(u.orgId, u.userId, badgeId, body);
  }

  @Get("badges/my")
  @RequirePermission("hr:engagement:view")
  myBadges(@CurrentUser() u: CurrentUserContext) {
    return this.svc.myBadges(u.orgId, u.userId);
  }

  @Get("points/my")
  @RequirePermission("hr:engagement:view")
  myPoints(@CurrentUser() u: CurrentUserContext) {
    return this.svc.myPoints(u.orgId, u.userId);
  }

  @Get("points/leaderboard")
  @RequirePermission("hr:engagement:view")
  leaderboard(
    @Query("top") top: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const n = Math.min(Number(top ?? 20), 50);
    return this.svc.leaderboard(u.orgId, n);
  }

  @Get("polls")
  @RequirePermission("hr:engagement:view")
  listPolls(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listPolls(u.orgId);
  }

  @Post("polls")
  @RequirePermission("hr:engagement:manage")
  @HttpCode(201)
  createPoll(
    @Body(new ZodValidationPipe(createPollSchema)) body: CreatePollInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createPoll(u.orgId, u.userId, body);
  }

  @Patch("polls/:pollId")
  @RequirePermission("hr:engagement:manage")
  updatePoll(
    @Param("pollId", ParseIntPipe) pollId: number,
    @Body(new ZodValidationPipe(updatePollSchema)) body: UpdatePollInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updatePoll(u.orgId, pollId, body);
  }

  @Post("polls/:pollId/vote")
  @RequirePermission("hr:engagement:view")
  @HttpCode(200)
  votePoll(
    @Param("pollId", ParseIntPipe) pollId: number,
    @Body(new ZodValidationPipe(votePollSchema)) body: VotePollInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.votePoll(u.orgId, u.userId, pollId, body);
  }

  @Get("polls/:pollId/results")
  @RequirePermission("hr:engagement:view")
  pollResults(
    @Param("pollId", ParseIntPipe) pollId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.pollResults(u.orgId, pollId);
  }

  @Get("communities")
  @RequirePermission("hr:engagement:view")
  listCommunities(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listCommunities(u.orgId);
  }

  @Post("communities")
  @RequirePermission("hr:engagement:view")
  @HttpCode(201)
  createCommunity(
    @Body(new ZodValidationPipe(createCommunitySchema)) body: CreateCommunityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createCommunity(u.orgId, u.userId, body);
  }

  @Post("communities/:communityId/join")
  @RequirePermission("hr:engagement:view")
  @HttpCode(200)
  joinCommunity(
    @Param("communityId", ParseIntPipe) communityId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.joinCommunity(u.orgId, u.userId, communityId);
  }

  @Post("communities/:communityId/leave")
  @RequirePermission("hr:engagement:view")
  @HttpCode(200)
  leaveCommunity(
    @Param("communityId", ParseIntPipe) communityId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.leaveCommunity(u.orgId, u.userId, communityId);
  }

  @Get("communities/:communityId/members")
  @RequirePermission("hr:engagement:view")
  communityMembers(
    @Param("communityId", ParseIntPipe) communityId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.communityMembers(u.orgId, communityId);
  }

  @Get("campaigns")
  @RequirePermission("hr:engagement:view")
  listCampaigns(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listCampaigns(u.orgId);
  }

  @Post("campaigns")
  @RequirePermission("hr:engagement:manage")
  @HttpCode(201)
  createCampaign(
    @Body(new ZodValidationPipe(createCampaignSchema)) body: CreateCampaignInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createCampaign(u.orgId, u.userId, body);
  }

  @Patch("campaigns/:campaignId")
  @RequirePermission("hr:engagement:manage")
  updateCampaign(
    @Param("campaignId", ParseIntPipe) campaignId: number,
    @Body(new ZodValidationPipe(updateCampaignSchema)) body: UpdateCampaignInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateCampaign(u.orgId, campaignId, body);
  }

  @Delete("campaigns/:campaignId")
  @HttpCode(204)
  @RequirePermission("hr:engagement:manage")
  async deleteCampaign(
    @Param("campaignId", ParseIntPipe) campaignId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.svc.deleteCampaign(u.orgId, campaignId);
  }

  @Get("employee-of-month")
  @RequirePermission("hr:engagement:view")
  employeeOfMonth(@CurrentUser() u: CurrentUserContext) {
    return this.svc.employeeOfMonth(u.orgId);
  }
}
