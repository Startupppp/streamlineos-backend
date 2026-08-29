import { Controller, Get, Param, ParseIntPipe, Post, Body, Query, UseGuards } from "@nestjs/common";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { resolveInvStockScope } from "../stock-engine/inventory-scope";
import { InvStockAdjustmentsService } from "./inv-stock-adjustments.service";
import {
  listAdjustmentsSchema, createAdjustmentSchema,
  type ListAdjustmentsInput, type CreateAdjustmentInput,
} from "./dto/inv-stock.schemas";

@RequireModule("inventory")
@Controller("inventory/stock/adjustments")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvStockAdjustmentsController {
  constructor(
    private readonly adjustments: InvStockAdjustmentsService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  async listAdjustments(
    @Query(new ZodValidationPipe(listAdjustmentsSchema)) filters: ListAdjustmentsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveInvStockScope(this.access, u);
    return this.adjustments.listAdjustments(u.orgId, filters, scope, u.userId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:adjust")
  createAdjustment(
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(createAdjustmentSchema)) body: CreateAdjustmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {return this.adjustments.createAdjustment(u.orgId, u.userId, body, idempotencyKey);
  }

  @Get(":adjustmentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  getAdjustment(
    @Param("adjustmentId", ParseIntPipe) adjustmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.adjustments.getAdjustment(u.orgId, adjustmentId, u.userId);
  }

  @Post(":adjustmentId/approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:adjustments:approve")
  approveAdjustment(
    @IdempotencyKey() idempotencyKey: string,
    @Param("adjustmentId", ParseIntPipe) adjustmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.adjustments.approveAdjustment(u.orgId, u.userId, adjustmentId, idempotencyKey);
  }

  @Post(":adjustmentId/post")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:adjustments:post")
  postAdjustment(
    @IdempotencyKey() idempotencyKey: string,
    @Param("adjustmentId", ParseIntPipe) adjustmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {return this.adjustments.postAdjustment(u.orgId, u.userId, adjustmentId, idempotencyKey);
  }

  @Post(":adjustmentId/cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:adjust")
  cancelAdjustment(
    @Param("adjustmentId", ParseIntPipe) adjustmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.adjustments.cancelAdjustment(u.orgId, adjustmentId);
  }
}
