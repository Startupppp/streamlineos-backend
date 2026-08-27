import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { InvReconciliationService } from "./inv-reconciliation.service";
import {
  reconciliationQuerySchema,
  repairSchema,
  type ReconciliationQueryInput,
  type RepairInput,
} from "./dto/reconciliation.schemas";

@RequireModule("inventory")
@Controller("inventory/stock/reconciliation")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvReconciliationController {
  constructor(private readonly reconciliation: InvReconciliationService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  report(
    @Query(new ZodValidationPipe(reconciliationQuerySchema)) query: ReconciliationQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reconciliation.report(u.orgId, u.userId, query);
  }

  /**
   * Rebuilding a projection is a write, so it is idempotent and permissioned
   * even though a repeat is a no-op — a retried request must not report a second
   * set of changed rows to whoever is watching.
   */
  @Post("repair")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:reconcile")
  @HttpCode(HttpStatus.OK)
  @Idempotent("inventory.stock.reconciliation.repair")
  repair(
    @Body(new ZodValidationPipe(repairSchema)) body: RepairInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reconciliation.repair(u.orgId, u.userId, body);
  }
}
