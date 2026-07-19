import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { KbResearchBriefService } from "./kb-research-brief.service";
import {
  kbResearchBriefCreateSchema,
  kbResearchBriefListSchema,
  kbResearchBriefRateSchema,
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
  async enqueue(@Body() body: unknown, @CurrentUser() u: CurrentUserContext): Promise<unknown> {
    const parsed = kbResearchBriefCreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");
    return this.briefs.enqueue(u, parsed.data);
  }

  @Get("research-briefs")
  @RequirePermission("kb:pages:view")
  async list(@Query() query: unknown, @CurrentUser() u: CurrentUserContext): Promise<unknown> {
    const parsed = kbResearchBriefListSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Invalid query parameters");
    return this.briefs.list(u, parsed.data);
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
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ success: boolean }> {
    const parsed = kbResearchBriefRateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");
    await this.briefs.rateBrief(u, briefId, parsed.data.rating);
    return { success: true };
  }
}
