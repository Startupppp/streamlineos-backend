import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { AiJobsService } from "../../ai/jobs/ai-jobs.service";
import { SupportKbGapService } from "./support-kb-gap.service";

const patchSchema = z.object({ action: z.literal("dismiss") });
type PatchInput = z.infer<typeof patchSchema>;

@RequireModule("support")
@Controller("support/knowledge-gaps")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SupportKbGapController {
  constructor(
    private readonly service: SupportKbGapService,
    private readonly aiJobs: AiJobsService,
  ) {}

  @Get()
  @RequirePermission("support:knowledge-gaps:view")
  listGaps(
    @CurrentUser() u: CurrentUserContext,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    const parsedCursor = cursor ? parseInt(cursor, 10) : undefined;
    const parsedLimit = limit ? Math.min(parseInt(limit, 10), 100) : 50;
    return this.service.listGaps(u.orgId, parsedCursor, parsedLimit);
  }

  @Post("detect")
  @HttpCode(200)
  @RequirePermission("support:knowledge-gaps:manage")
  detectGaps(@CurrentUser() u: CurrentUserContext) {
    const idempotencyKey = `gap-detect:${u.orgId}:${new Date().toISOString().slice(0, 10)}`;
    return this.aiJobs.enqueue({
      orgId: u.orgId,
      userId: u.userId,
      type: "support.kb-gap-detect",
      payload: { orgId: u.orgId },
      idempotencyKey,
    });
  }

  @Post(":gapId/draft")
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("support:knowledge-gaps:manage")
  async proposeDraft(
    @Param("gapId", ParseIntPipe) gapId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const gap = await this.service.proposeDraft(u.orgId, gapId, u.userId, u);
    return { gap };
  }

  @Patch(":gapId")
  @RequirePermission("support:knowledge-gaps:manage")
  patchGap(
    @Param("gapId", ParseIntPipe) gapId: number,
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(patchSchema)) body: PatchInput,
  ) {
    if (body.action === "dismiss") {
      return this.service.dismissGap(u.orgId, gapId);
    }
  }
}
