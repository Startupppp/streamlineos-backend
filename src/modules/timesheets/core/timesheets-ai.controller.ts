import { Body, Controller, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { TimesheetsAiService } from "./timesheets-ai.service";
import {
  describeEntrySchema,
  type DescribeEntryInput,
  billingNarrativeSchema,
  type BillingNarrativeInput,
  rejectionDraftSchema,
  type RejectionDraftInput,
} from "./dto/ai.schemas";
import { overviewQuerySchema, type OverviewQuery } from "./dto/reports.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const periodIdParams = z.object({ periodId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("timesheets")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard, RateLimitGuard)
export class TimesheetsAiController {
  constructor(private readonly ai: TimesheetsAiService) {}

  @Post("periods/:periodId/ai/summarize")
  @HttpCode(200)
  @RequirePermission("timesheets:entries:view")
  @UseRateLimit("ai:invoke")
  @Validate({ params: periodIdParams })
  summarize(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ai.summarizePeriod(u, periodId);
  }

  @Post("periods/:periodId/ai/rejection-reason")
  @HttpCode(200)
  @RequirePermission("timesheets:approvals:manage")
  @UseRateLimit("ai:invoke")
  @Validate({ params: periodIdParams, body: rejectionDraftSchema })
  draftRejectionReason(
    @Param("periodId", ParseIntPipe) periodId: number,
    @Body() body: RejectionDraftInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ai.draftRejectionReason(u, periodId, body);
  }

  @Post("ai/describe-entry")
  @HttpCode(200)
  @RequirePermission("timesheets:entries:create")
  @UseRateLimit("ai:invoke")
  @Validate({ body: describeEntrySchema })
  describeEntry(
    @Body() body: DescribeEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ai.describeEntry(u, body);
  }

  @Post("ai/billing-narrative")
  @HttpCode(200)
  @RequirePermission("timesheets:billing:view")
  @UseRateLimit("ai:invoke")
  @Validate({ body: billingNarrativeSchema })
  billingNarrative(
    @Body() body: BillingNarrativeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ai.billingNarrative(u, body);
  }

  @Post("ai/reports-narrative")
  @HttpCode(200)
  @RequirePermission("timesheets:reports:view")
  @UseRateLimit("ai:invoke")
  @Validate({ body: overviewQuerySchema })
  reportsNarrative(
    @Body() body: OverviewQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ai.reportsNarrative(u, body);
  }
}
