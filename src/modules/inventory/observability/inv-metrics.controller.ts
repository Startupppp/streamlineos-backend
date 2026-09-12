import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { InventoryMetricsService } from "./inventory-metrics.service";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { inventoryMetricsResponseSchema } from "./dto/inv-metrics-response.schemas";

/**
 * G6 — one operator surface for PRD §9.
 *
 * Behind `inventory:settings:manage` rather than `inventory:reports:read`: these
 * are numbers about the *system*, not about the business, and a figure like
 * "orphaned reservations" is a maintenance signal that reads as alarming to
 * somebody who only wants a stock report.
 *
 * Tenant-scoped from `@CurrentUser()`, never from a parameter — a cross-tenant
 * metrics read would be an information leak dressed as observability.
 */
@RequireModule("inventory")
@Controller("inventory/metrics")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvMetricsController {
  constructor(private readonly svc: InventoryMetricsService) {}

  @Get()
  @ResponseSchema(inventoryMetricsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:settings:manage")
  snapshot(@CurrentUser() u: CurrentUserContext) {
    return this.svc.snapshot(u.orgId);
  }
}
