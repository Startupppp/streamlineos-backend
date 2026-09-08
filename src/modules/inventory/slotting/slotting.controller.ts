import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  Headers,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Public } from "../../../common/auth/public.decorator";
import { assertCronSecret } from "../../cron/cron-secret";
import { SlottingService, type ReslotSweepResult } from "./slotting.service";
import { InvStockTransfersService } from "../stock/inv-stock-transfers.service";
import {
  approveRecommendationSchema,
  createSlottingRuleSchema,
  dismissRecommendationSchema,
  listRecommendationsQuerySchema,
  listSlottingRulesQuerySchema,
  setSlottingRuleActiveSchema,
} from "./dto/slotting.schemas";
import type {
  ApproveRecommendationInput, CreateSlottingRuleInput, DismissRecommendationInput, ListRecommendationsQuery, ListSlottingRulesQuery, SetSlottingRuleActiveInput } from "./dto/slotting.schemas";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";

/**
 * NEO-6 - slotting.
 *
 * Rules are `inventory:warehouses:manage`: deciding which zone a class of SKU
 * lives in is a decision about the building, and it is the key that already
 * governs zones and bins. Reading recommendations is `inventory:stock:read`.
 *
 * **Approving** one is `inventory:stock:transfer`, deliberately a different key:
 * approving raises a transfer, and whoever plans a layout is not automatically
 * somebody who may move stock. Dismissing stays on the read-adjacent manage key
 * because it touches nothing.
 */
@RequireModule("inventory")
@Controller("inventory/slotting")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class SlottingController {
  constructor(
    private readonly svc: SlottingService,
    private readonly transfers: InvStockTransfersService,
  ) {}

  @Get("rules")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:read")
  listRules(
    @Query(new ZodValidationPipe(listSlottingRulesQuerySchema)) query: ListSlottingRulesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listRules(u.orgId, u.userId, query.warehouseId);
  }

  @Post("rules")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  @Idempotent("inventory.slotting.rule.create")
  createRule(
    @Body(new ZodValidationPipe(createSlottingRuleSchema)) body: CreateSlottingRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createRule(u.orgId, u.userId, body);
  }

  @Patch("rules/:ruleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  setRuleActive(
    @Param("ruleId", ParseIntPipe) ruleId: number,
    @Body(new ZodValidationPipe(setSlottingRuleActiveSchema)) body: SetSlottingRuleActiveInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.setRuleActive(u.orgId, u.userId, ruleId, body.isActive);
  }

  @Get("recommendations")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  listRecommendations(
    @Query(new ZodValidationPipe(listRecommendationsQuerySchema)) query: ListRecommendationsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listRecommendations(u.orgId, u.userId, query);
  }

  @Post("recommendations/:recommendationId/dismiss")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:warehouses:manage")
  @Idempotent("inventory.slotting.recommendation.dismiss")
  dismiss(
    @Param("recommendationId", ParseIntPipe) recommendationId: number,
    @Body(new ZodValidationPipe(dismissRecommendationSchema)) body: DismissRecommendationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.dismiss(u.orgId, u.userId, recommendationId, body.reason);
  }

  /**
   * Approving marks the decision and then raises an ordinary transfer through
   * `InvStockService` - the same command a person would use by hand. A re-slot
   * with its own posting path is how a second stock engine starts.
   */
  @Post("recommendations/:recommendationId/approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  async approve(
    @Param("recommendationId", ParseIntPipe) recommendationId: number,
    @Body(new ZodValidationPipe(approveRecommendationSchema)) body: ApproveRecommendationInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const approved = await this.svc.approve(
      u.orgId,
      u.userId,
      recommendationId,
      body.toLocationId,
    );
    const transfer = await this.transfers.createTransfer(u.orgId, u.userId, {
      fromLocationId: approved.move.fromLocationId,
      toLocationId: body.toLocationId,
      notes: `Re-slot from recommendation ${recommendationId}`,
      lines: [
        {
          productVariantId: approved.move.productVariantId,
          quantity: Number(approved.move.quantity),
        },
      ],
    }, idempotencyKey);
    return { ...approved, transfer };
  }
}

/**
 * NEO-6 - the nightly re-slot sweep.
 *
 * Beside the service rather than in `modules/cron/`, for the reason the channel
 * snapshot drain gives: the route is part of this module's contract, and putting
 * it in the cron module would make `CronModule` import the whole of inventory to
 * reach one method. `@Public()` because the caller is a scheduler with no
 * session; `assertCronSecret` is the gate.
 *
 * The sweep is read-only. It recomputes velocity and writes recommendations, and
 * moves no stock.
 */
@Public()
@Controller("cron")
export class SlottingCronController {
  constructor(private readonly svc: SlottingService) {}

  @Get("inventory-reslot")
  runGet(@Headers("authorization") authorization?: string): Promise<ReslotSweepResult> {
    return this.run(authorization);
  }

  @Post("inventory-reslot")
  @HttpCode(HttpStatus.OK)
  runPost(@Headers("authorization") authorization?: string): Promise<ReslotSweepResult> {
    return this.run(authorization);
  }

  private run(authorization?: string): Promise<ReslotSweepResult> {
    assertCronSecret(authorization);
    return this.svc.runReslotSweep();
  }
}
