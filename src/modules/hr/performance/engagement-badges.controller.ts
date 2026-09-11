import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
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
import { EngagementBadgesService } from "./engagement-badges.service";
import {
  awardBadgeSchema,
  createBadgeSchema,
  type AwardBadgeInput,
  type CreateBadgeInput,
} from "./dto/engagement-extras.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts"
import { overviewResponseSchema, listBadgesResponseSchema, createBadgeResponseSchema, awardBadgeResponseSchema, myBadgesResponseSchema, myPointsResponseSchema, leaderboardResponseSchema, employeeOfMonthResponseSchema } from "./dto/engagement-extras-response.schemas"

const badgeIdParams = z
  .object({ badgeId: z.coerce.number().int().positive() })
  .strict();

@RequireModule("hr")
@Controller("hr/engagement")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EngagementBadgesController {
  constructor(private readonly badges: EngagementBadgesService) {}

  @ResponseSchema(overviewResponseSchema)
  @Get("overview")
  @RequirePermission("hr:engagement:view")
  async overview(@CurrentUser() u: CurrentUserContext) {
    const [eom, leaderboard] = await Promise.all([
      this.badges.employeeOfMonth(u.orgId),
      this.badges.leaderboard(u.orgId, 5),
    ]);
    return { employeeOfMonth: eom, topLeaderboard: leaderboard };
  }

  @ResponseSchema(listBadgesResponseSchema)
  @Get("badges")
  @RequirePermission("hr:engagement:view")
  listBadges(@CurrentUser() u: CurrentUserContext) {
    return this.badges.listBadges(u.orgId);
  }

  @ResponseSchema(createBadgeResponseSchema)
  @Post("badges")
  @RequirePermission("hr:engagement:manage")
  @HttpCode(201)
  @Validate({ body: createBadgeSchema })
  createBadge(
    @Body() body: CreateBadgeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.badges.createBadge(u.orgId, body);
  }

  @NoContentResponse()
  @Delete("badges/:badgeId")
  @HttpCode(204)
  @RequirePermission("hr:engagement:manage")
  @Validate({ params: badgeIdParams })
  async deleteBadge(
    @Param("badgeId", ParseIntPipe) badgeId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.badges.deleteBadge(u.orgId, badgeId);
  }

  @ResponseSchema(awardBadgeResponseSchema)
  @Post("badges/:badgeId/award")
  @RequirePermission("hr:engagement:manage")
  @HttpCode(201)
  @Validate({ params: badgeIdParams, body: awardBadgeSchema })
  awardBadge(
    @Param("badgeId", ParseIntPipe) badgeId: number,
    @Body() body: AwardBadgeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.badges.awardBadge(u.orgId, u.userId, badgeId, body);
  }

  @ResponseSchema(myBadgesResponseSchema)
  @Get("badges/my")
  @RequirePermission("hr:engagement:view")
  myBadges(@CurrentUser() u: CurrentUserContext) {
    return this.badges.myBadges(u.orgId, u.userId);
  }

  @ResponseSchema(myPointsResponseSchema)
  @Get("points/my")
  @RequirePermission("hr:engagement:view")
  myPoints(@CurrentUser() u: CurrentUserContext) {
    return this.badges.myPoints(u.orgId, u.userId);
  }

  @ResponseSchema(leaderboardResponseSchema)
  @Get("points/leaderboard")
  @RequirePermission("hr:engagement:view")
  leaderboard(
    @Query("top") top: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const n = Math.min(Number(top ?? 20), 50);
    return this.badges.leaderboard(u.orgId, n);
  }

  @ResponseSchema(employeeOfMonthResponseSchema)
  @Get("employee-of-month")
  @RequirePermission("hr:engagement:view")
  employeeOfMonth(@CurrentUser() u: CurrentUserContext) {
    return this.badges.employeeOfMonth(u.orgId);
  }
}
