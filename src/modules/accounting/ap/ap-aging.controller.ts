import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ApAgingService } from "./ap-aging.service";
import { apAgingQuerySchema, type ApAgingQuery } from "./dto/ap-aging.schemas";

@RequireModule("accounting")
@Controller("accounting/payables/aging")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class ApAgingController {
  constructor(private readonly aging: ApAgingService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  agedPayables(
    @Query(new ZodValidationPipe(apAgingQuerySchema)) query: ApAgingQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.aging.agedPayables(user.orgId, query);
  }
}
