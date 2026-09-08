import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Body,
  Query,
  UseGuards,
} from "@nestjs/common";
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
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";

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
    @IdempotencyKey() idempotencyKey: string,
    @Body() body: CreateAdjustmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
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
    return this.adjustments.getAdjustment(u.orgId, adjustmentId, u.userId);
  }

  @Post(":adjustmentId/approve")
  @BodylessAction()
  @Idempotent("inventory.stock-adjustment.approve")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:adjustments:approve")
  @Validate({ params: adjustmentIdParams })
  approveAdjustment(
    @IdempotencyKey() idempotencyKey: string,
    @Param("adjustmentId", ParseIntPipe) adjustmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.adjustments.approveAdjustment(u.orgId, u.userId, adjustmentId, idempotencyKey);
  }

  @Post(":adjustmentId/post")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:adjustments:post")
  @Validate({ params: adjustmentIdParams })
  postAdjustment(
    @IdempotencyKey() idempotencyKey: string,
    @Param("adjustmentId", ParseIntPipe) adjustmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.adjustments.postAdjustment(u.orgId, u.userId, adjustmentId, idempotencyKey);
  }

  @Post(":adjustmentId/cancel")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:stock:adjust")
  @Idempotent("inventory.stock-adjustment.cancel")
  @Validate({ params: adjustmentIdParams })
  cancelAdjustment(
    @Param("adjustmentId", ParseIntPipe) adjustmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.adjustments.cancelAdjustment(u.orgId, adjustmentId);
  }
}
