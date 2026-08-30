import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { KbPageAiService } from "./kb-page-ai.service";
import { kbAiAskBodySchema } from "../retrieval/dto/kb-ai.schemas";

const pageIdParams = z.object({ pageId: z.coerce.number().int().positive() }).strict();

type KbAiAskBody = z.infer<typeof kbAiAskBodySchema>;

@Controller("kb/pages/:pageId/ai")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@UseRateLimit("ai:invoke")
export class KbPageAiController {
  constructor(private readonly svc: KbPageAiService) {}

  @Post("summarize")
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  async summarize(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.summarize(u, pageId);
  }

  @Post("ask")
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams, body: kbAiAskBodySchema })
  async ask(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body() body: KbAiAskBody,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.ask(u, pageId, body.question);
  }

  @Post("improve")
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  async improve(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.improve(u, pageId);
  }

  @Post("suggest-related")
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  async suggestRelated(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.svc.suggestRelated(u, pageId);
  }
}
