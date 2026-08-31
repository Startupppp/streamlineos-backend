import { BadRequestException, Controller, Get, Headers, Param, ParseIntPipe, Post, Body, Query, UseGuards } from "@nestjs/common";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { resolveInvStockScope } from "../stock-engine/inventory-scope";
import { InvStockAdjustmentsService } from "./inv-stock-adjustments.service";
import {
  listAdjustmentsSchema, createAdjustmentSchema,
  type ListAdjustmentsInput, type CreateAdjustmentInput,
} from "./dto/inv-stock.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const adjustmentIdParams = z.object({ adjustmentId: z.coerce.number().int().positive() }).strict();

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
  @Validate({ query: listAdjustmentsSchema })
  async listAdjustments(
    @Query() filters: ListAdjustmentsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveInvStockScope(this.access, u);
    return this.adjustments.listAdjustments(u.orgId, filters, scope, u.userId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:adjust")
  @Validate({ body: createAdjustmentSchema })
  createAdjustment(
    @Headers("idempotency-key") idempotencyKey: string,
    @Body() body: CreateAdjustmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header required");
    return this.adjustments.createAdjustment(u.orgId, u.userId, body, idempotencyKey);
  }

  @Get(":adjustmentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:read")
  @Validate({ params: adjustmentIdParams })
  getAdjustment(
    @Param("adjustmentId", ParseIntPipe) adjustmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.adjustments.getAdjustment(u.orgId, adjustmentId);
  }

  @Post(":adjustmentId/approve")
  @Idempotent("inventory.stock-adjustment.approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:adjustments:approve")
  @Validate({ params: adjustmentIdParams })
  @BodylessAction()
  approveAdjustment(
    @Param("adjustmentId", ParseIntPipe) adjustmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.adjustments.approveAdjustment(u.orgId, u.userId, adjustmentId);
  }

  @Post(":adjustmentId/post")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:adjustments:post")
  @Validate({ params: adjustmentIdParams })
  @BodylessAction()
  postAdjustment(
    @Headers("idempotency-key") idempotencyKey: string,
    @Param("adjustmentId", ParseIntPipe) adjustmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!idempotencyKey) throw new BadRequestException("Idempotency-Key header required");
    return this.adjustments.postAdjustment(u.orgId, u.userId, adjustmentId, idempotencyKey);
  }

  @Post(":adjustmentId/cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:adjust")
  @Validate({ params: adjustmentIdParams })
  @BodylessAction()
  cancelAdjustment(
    @Param("adjustmentId", ParseIntPipe) adjustmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.adjustments.cancelAdjustment(u.orgId, adjustmentId);
  }
}
