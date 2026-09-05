import {
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { NoTenantTransaction } from "../../../../common/tenant/no-tenant-transaction.decorator";
import { ExecutiveBriefService } from "./executive-brief.service";
import { BodylessAction } from "../../../../common/openapi/zod-operation-contracts";
import { AiRequestAbortInterceptor } from "../streaming";
import { respondWithAiTextStream } from "../streaming/ai-text-stream-route";
import type { Request, Response } from "express";
import { ApiOkResponse } from "@nestjs/swagger";

@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("ai/executive-brief")
@NoTenantTransaction()
@UseInterceptors(AiRequestAbortInterceptor)
export class ExecutiveBriefController {
  constructor(private readonly service: ExecutiveBriefService) {}

  @RequirePermission("ai:executive-brief:view")
  @Get()
  async getLatest(@CurrentUser() u: CurrentUserContext) {
    return this.service.getLatest(u.orgId);
  }

  @RequirePermission("ai:executive-brief:generate")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @Post("generate")
  @BodylessAction()
  async generate(@CurrentUser() u: CurrentUserContext) {
    return this.service.generate(u.orgId, u.userId);
  }

  @RequirePermission("ai:executive-brief:generate")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @Post("stream-generate")
  @HttpCode(200)
  @ApiOkResponse({
    description: "Streaming executive brief text; citations in x-ai-sources; snapshot committed before EOF",
    content: { "text/plain": { schema: { type: "string" } } },
  })
  @BodylessAction()
  async streamGenerate(@CurrentUser() u: CurrentUserContext, @Req() req: Request, @Res() res: Response) {
    await respondWithAiTextStream(req, res, {
      feature: "exec.brief.generate",
      orgId: u.orgId,
      route: "POST /ai/executive-brief/stream-generate",
      sourcesHeader: "x-ai-sources",
    }, (signal) => this.service.streamGenerate(u.orgId, u.userId, signal));
  }
}
