import { Controller, Get, Query, UseGuards } from "@nestjs/common";
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
  contentHealthSignalsPageSchema,
  contentHealthCountsSchema,
  type ContentHealthSignalsQuery,
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
  @ResponseSchema(contentHealthCountsSchema)
  @Get("wiki/content-health/counts")
  counts(@CurrentUser() user: CurrentUserContext) {
    return this.contentHealth.counts(user);
  }
}
