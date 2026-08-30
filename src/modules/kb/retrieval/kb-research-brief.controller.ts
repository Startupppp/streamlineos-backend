import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { KbResearchBriefService } from "./kb-research-brief.service";
import {
  kbResearchBriefCreateSchema,
  kbResearchBriefListSchema,
  kbResearchBriefRateSchema,
  type KbResearchBriefCreateInput,
  type KbResearchBriefListInput,
  type KbResearchBriefRateInput,
} from "./dto/kb-ai.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbResearchBriefController {
  constructor(private readonly briefs: KbResearchBriefService) {}

  @Post("research-briefs")
  @RequirePermission("kb:pages:view")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @HttpCode(201)
  async enqueue(
    @Body(new ZodValidationPipe(kbResearchBriefCreateSchema)) body: KbResearchBriefCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.briefs.enqueue(u, body);
  }

  @Get("research-briefs")
  @RequirePermission("kb:pages:view")
  async list(
    @Query(new ZodValidationPipe(kbResearchBriefListSchema)) query: KbResearchBriefListInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.briefs.list(u, query);
  }

  @Get("research-briefs/:briefId")
  @RequirePermission("kb:pages:view")
  async getById(
    @Param("briefId", ParseIntPipe) briefId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.briefs.getById(u, briefId);
  }

  @Post("research-briefs/:briefId/rate")
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  async rateBrief(
    @Param("briefId", ParseIntPipe) briefId: number,
    @Body(new ZodValidationPipe(kbResearchBriefRateSchema)) body: KbResearchBriefRateInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ success: boolean }> {
    await this.briefs.rateBrief(u, briefId, body.rating);
    return { success: true };
  }
}
