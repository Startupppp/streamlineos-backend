import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbResearchBriefService } from "./kb-research-brief.service";
import {
  kbResearchBriefCreateSchema,
  kbResearchBriefListSchema,
  kbResearchBriefRateSchema,
  type KbResearchBriefCreateInput,
} from "./dto/kb-ai.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  kbResearchBriefEnqueueSchema,
  kbResearchBriefListSchema as kbResearchBriefListResponseSchema,
  kbResearchBriefDetailSchema,
  kbResearchBriefRateSchema as kbResearchBriefRateResponseSchema,
} from "./dto/kb-retrieval-response.schemas";
import { z } from "zod";

const briefIdParams = z.object({ briefId: z.coerce.number().int().positive() }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbResearchBriefController {
  constructor(private readonly briefs: KbResearchBriefService) {}

  @Post("research-briefs")
  @RequirePermission("kb:pages:view")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @HttpCode(201)
  @Validate({ body: kbResearchBriefCreateSchema })
  @ResponseSchema(kbResearchBriefEnqueueSchema)
  async enqueue(@Body() body: KbResearchBriefCreateInput, @CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.briefs.enqueue(u, body);
  }

  @Get("research-briefs")
  @RequirePermission("kb:pages:view")
  @ResponseSchema(kbResearchBriefListResponseSchema)
  async list(@Query() query: unknown, @CurrentUser() u: CurrentUserContext): Promise<unknown> {
    const parsed = kbResearchBriefListSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Invalid query parameters");
    return this.briefs.list(u, parsed.data);
  }

  @Get("research-briefs/:briefId")
  @RequirePermission("kb:pages:view")
  @Validate({ params: briefIdParams })
  @ResponseSchema(kbResearchBriefDetailSchema)
  async getById(
    @Param("briefId", ParseIntPipe) briefId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.briefs.getById(u, briefId);
  }

  @Post("research-briefs/:briefId/rate")
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  @Validate({ params: briefIdParams, body: kbResearchBriefRateSchema })
  @ResponseSchema(kbResearchBriefRateResponseSchema)
  async rateBrief(
    @Param("briefId", ParseIntPipe) briefId: number,
    @Body() body: z.infer<typeof kbResearchBriefRateSchema>,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ success: boolean }> {
    await this.briefs.rateBrief(u, briefId, body.rating);
    return { success: true };
  }

  @Post("research-briefs/:briefId/retry")
  @BodylessAction()
  @RequirePermission("kb:pages:view")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @HttpCode(200)
  @Validate({ params: briefIdParams })
  @ResponseSchema(kbResearchBriefEnqueueSchema)
  async retryBrief(
    @Param("briefId", ParseIntPipe) briefId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.briefs.retryBrief(u, briefId);
  }

  @Delete("research-briefs/:briefId")
  @RequirePermission("kb:pages:view")
  @HttpCode(204)
  @Validate({ params: briefIdParams })
  @NoContentResponse()
  async cancelBrief(
    @Param("briefId", ParseIntPipe) briefId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    await this.briefs.cancelBrief(u, briefId);
  }
}
