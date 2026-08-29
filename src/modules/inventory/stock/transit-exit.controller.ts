import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { TransitExitService } from "./transit-exit.service";
import {
  listStrandedTransitSchema,
  transitExitSchema,
  type ListStrandedTransitInput,
  type TransitExitInput,
} from "./dto/transit-exit.schemas";

/**
 * R3 — the two routes that make transit a place goods can leave.
 *
 * Its own controller rather than two more handlers on
 * `InvStockTransfersController`, because they answer to a different authority.
 * Everything on that controller is gated at `inventory:stock:transfer`, which is
 * the key an operator holds to move goods between bins; deciding that stranded
 * units are a loss is a supervisor's call and has its own key. Adding a route
 * with a stronger gate to a class whose every sibling has the weaker one is how
 * the stronger one gets quietly relaxed later to "match".
 */
@RequireModule("inventory")
@Controller("inventory/stock/transit")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class TransitExitController {
  constructor(private readonly transitExit: TransitExitService) {}

  /**
   * The queue. Read-gated at `inventory:stock:read` — knowing what is standing in
   * transit is ordinary stock visibility, and a supervisor who cannot see the
   * queue cannot decide anything about it.
   */
  @Get("stranded")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  listStranded(
    @Query(new ZodValidationPipe(listStrandedTransitSchema))
    query: ListStrandedTransitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transitExit.listStranded(u.orgId, u.userId, query);
  }

  /**
   * The decision. Both dispositions post movements, so the key demands one
   * idempotency header: a retried exit that ran twice would take the quantity
   * off transit twice, and the second pass would eat another transfer's goods
   * standing on the same warehouse bin.
   */
  @Post("exit")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:transit:abandon")
  exitTransit(
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(transitExitSchema)) body: TransitExitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transitExit.exitTransit(u.orgId, u.userId, body, idempotencyKey);
  }
}
