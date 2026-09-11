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
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { AiJobsService } from "../../ai/jobs/ai-jobs.service";
import { SupportKbGapService } from "./support-kb-gap.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  gapListResponseSchema,
  detectGapsJobSchema,
  proposeDraftResponseSchema,
  dismissGapResponseSchema,
} from "./dto/support-kb-gap-response.schemas";
import {
  listGapsQuerySchema,
  dismissGapPatchSchema,
  type ListGapsQuery,
  type DismissGapPatchInput,
} from "./dto/support-kb-gap.schemas";

const gapIdParams = z.object({ gapId: z.coerce.number().int().positive() }).strict();

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
  @Validate({ query: listGapsQuerySchema })
  @ResponseSchema(gapListResponseSchema)
  listGaps(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListGapsQuery,
  ) {
    return this.service.listGaps(u.orgId, query.cursor, query.limit);
  }

  @Post("detect")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("support:knowledge-gaps:manage")
  @ResponseSchema(detectGapsJobSchema)
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
  @BodylessAction()
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:invoke")
  @RequirePermission("support:knowledge-gaps:manage")
  @Validate({ params: gapIdParams })
  @ResponseSchema(proposeDraftResponseSchema)
  async proposeDraft(
    @Param("gapId", ParseIntPipe) gapId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const gap = await this.service.proposeDraft(u.orgId, gapId, u.userId, u);
    return { gap };
  }

  @Patch(":gapId")
  @RequirePermission("support:knowledge-gaps:manage")
  @Validate({ params: gapIdParams, body: dismissGapPatchSchema })
  @ResponseSchema(dismissGapResponseSchema)
  patchGap(
    @Param("gapId", ParseIntPipe) gapId: number,
    @CurrentUser() u: CurrentUserContext,
    @Body() body: DismissGapPatchInput,
  ) {
    if (body.action === "dismiss") {
      return this.service.dismissGap(u.orgId, gapId);
    }
  }
}
