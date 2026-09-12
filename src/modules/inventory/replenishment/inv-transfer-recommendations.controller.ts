import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { TransferRecommendationService } from "./forecast/transfer-recommendation.service";
import { TransferApprovalService } from "./forecast/transfer-approval.service";
import {
  approveTransferRecommendationSchema,
  transferPlanQuerySchema,
  type ApproveTransferRecommendationInput,
  type TransferPlanQuery,
} from "./dto/transfer-recommendation.schemas";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  approveTransferRecommendationResponseSchema,
  transferPlanResponseSchema,
} from "./dto/forecast-response.schemas";

/**
 * C5 — the transfer plan, and approving one move from it.
 *
 * The plan was computed by a service nothing could reach. Reading it is a
 * planning question and sits behind `inventory:replenishment:read`; approving
 * one moves stock between two warehouses and sits behind
 * `inventory:stock:transfer`, the same key the transfer endpoints themselves
 * carry — a planner who may read the network should not thereby be able to move
 * goods around it.
 */
@RequireModule("inventory")
@Controller("inventory/replenishment/transfer-recommendations")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvTransferRecommendationsController {
  constructor(
    private readonly recommendations: TransferRecommendationService,
    private readonly approvals: TransferApprovalService,
  ) {}

  /**
   * Every site's position for one SKU, and the moves that would fix it.
   *
   * Scoped to the warehouses the caller can see, by the service — a plan that
   * named a donor the reader has no access to would be advice they cannot act
   * on and a disclosure of a site's stock at the same time.
   */
  @Get(":productVariantId")
  @ResponseSchema(transferPlanResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:replenishment:read")
  plan(
    @Param("productVariantId", ParseIntPipe) productVariantId: number,
    @Query(new ZodValidationPipe(transferPlanQuerySchema)) query: TransferPlanQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.recommendations.plan(u.orgId, u.userId, productVariantId, {
      ...(query.weeks === undefined ? {} : { weeks: query.weeks }),
    });
  }

  /**
   * Turn one recommendation into a standard PENDING transfer.
   *
   * The body names the move, never the quantity — the units are re-derived from
   * the plan here. A second call with the same `Idempotency-Key` replays the
   * first transfer and creates nothing.
   */
  @Post("approve")
  @ResponseSchema(approveTransferRecommendationResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:transfer")
  approve(
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(approveTransferRecommendationSchema))
    body: ApproveTransferRecommendationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.approve(u.orgId, u.userId, body, idempotencyKey);
  }
}
