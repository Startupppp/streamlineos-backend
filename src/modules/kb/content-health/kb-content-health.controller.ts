import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbContentHealthService } from "./kb-content-health.service";
import {
  contentHealthSignalsQuerySchema,
  contentHealthCountsQuerySchema,
  contentHealthSignalsPageSchema,
  contentHealthCountsSchema,
  dismissHealthItemBodySchema,
  assignHealthItemBodySchema,
  bulkRepairBodySchema,
  bulkRepairResponseSchema,
  evidenceQuerySchema,
  evidenceResponseSchema,
  contentHealthTrendSchema,
  healthItemSchema,
  type ContentHealthSignalsQuery,
  type ContentHealthCountsQuery,
  type DismissHealthItemBody,
  type AssignHealthItemBody,
  type BulkRepairBody,
  type EvidenceQuery,
} from "./dto/kb-content-health.schemas";

@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("kb")
export class KbContentHealthController {
  constructor(private readonly contentHealth: KbContentHealthService) {}

  @RequirePermission("kb:pages:manage")
  @Validate({ query: contentHealthSignalsQuerySchema })
  @ResponseSchema(contentHealthSignalsPageSchema)
  @Get("wiki/content-health/signals")
  signals(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ContentHealthSignalsQuery,
  ) {
    return this.contentHealth.signals(user, query);
  }

  @RequirePermission("kb:pages:manage")
  @Validate({ query: contentHealthCountsQuerySchema })
  @ResponseSchema(contentHealthCountsSchema)
  @Get("wiki/content-health/counts")
  counts(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ContentHealthCountsQuery,
  ) {
    return this.contentHealth.counts(user, query);
  }

  @RequirePermission("kb:pages:manage")
  @Validate({ body: dismissHealthItemBodySchema })
  @ResponseSchema(healthItemSchema)
  @Post("wiki/content-health/signals/dismiss")
  dismiss(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: DismissHealthItemBody,
  ) {
    return this.contentHealth.dismiss(user, body);
  }

  @RequirePermission("kb:pages:manage")
  @Validate({ body: assignHealthItemBodySchema })
  @ResponseSchema(healthItemSchema)
  @Post("wiki/content-health/signals/assign")
  assign(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: AssignHealthItemBody,
  ) {
    return this.contentHealth.assign(user, body);
  }

  @RequirePermission("kb:pages:manage")
  @Validate({ body: bulkRepairBodySchema })
  @ResponseSchema(bulkRepairResponseSchema)
  @Post("wiki/content-health/signals/bulk-repair")
  bulkRepair(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: BulkRepairBody,
  ) {
    return this.contentHealth.bulkRepair(user, body);
  }

  @RequirePermission("kb:pages:manage")
  @Validate({ query: evidenceQuerySchema })
  @ResponseSchema(evidenceResponseSchema)
  @Get("wiki/content-health/signals/evidence")
  evidence(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: EvidenceQuery,
  ) {
    return this.contentHealth.getEvidence(user, query);
  }

  @RequirePermission("kb:pages:manage")
  @ResponseSchema(contentHealthTrendSchema)
  @Get("wiki/content-health/trend")
  trend(@CurrentUser() user: CurrentUserContext) {
    return this.contentHealth.trend(user);
  }
}
