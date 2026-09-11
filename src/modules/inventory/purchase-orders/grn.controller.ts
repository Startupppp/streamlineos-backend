import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, Query, UseGuards, HttpCode, HttpStatus } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { GrnService } from "./grn.service";
import { GrnReadService } from "./grn-read.service";
import {
  listGrnSchema, reverseGrnSchema, createGrnDraftSchema, updateGrnDraftSchema, cancelGrnSchema,
  type ListGrnInput, type ReverseGrnInput, type CreateGrnDraftInput,
  type UpdateGrnDraftInput, type CancelGrnInput,
} from "./dto/inv-purchase-orders.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  listGrnsResponseSchema,
  getGrnResponseSchema,
  reverseGrnResponseSchema,
} from "./dto/purchase-orders-response.schemas";

const grnIdParams = z.object({ grnId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/goods-receipts")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class GrnController {
  constructor(
    private readonly grns: GrnService,
    private readonly reads: GrnReadService,
  ) {}

  @Get()
  @ResponseSchema(listGrnsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:read")
  @Validate({ query: listGrnSchema })
  list(
    @Query() filters: ListGrnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reads.listGrns(u.orgId, u.userId, filters);
  }

  @Get(":grnId")
  @ResponseSchema(getGrnResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:read")
  @Validate({ params: grnIdParams })
  get(
    @Param("grnId", ParseIntPipe) grnId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reads.getGrn(u.orgId, grnId, u.userId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:receive")
  @HttpCode(HttpStatus.CREATED)
  @Validate({ body: createGrnDraftSchema })
  createDraft(
    @Body() body: CreateGrnDraftInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grns.createDraft(u.orgId, u.userId, idempotencyKey, body);
  }

  @Patch(":grnId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:receive")
  @Validate({ params: grnIdParams, body: updateGrnDraftSchema })
  updateDraft(
    @Param("grnId", ParseIntPipe) grnId: number,
    @Body() body: UpdateGrnDraftInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grns.updateDraft(u.orgId, grnId, u.userId, body);
  }

  @Post(":grnId/count")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:receive")
  @Idempotent("inventory.grn.counting.start")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: grnIdParams })
  startCounting(
    @Param("grnId", ParseIntPipe) grnId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grns.startCounting(u.orgId, grnId, u.userId);
  }

  @Post(":grnId/quality-review")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:receive")
  @Idempotent("inventory.grn.quality-review.submit")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: grnIdParams })
  submitForQualityReview(
    @Param("grnId", ParseIntPipe) grnId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grns.submitForQualityReview(u.orgId, grnId, u.userId);
  }

  @Post(":grnId/post")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:receive")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: grnIdParams })
  post(
    @Param("grnId", ParseIntPipe) grnId: number,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grns.postGrn(u.orgId, grnId, u.userId, idempotencyKey);
  }

  @Post(":grnId/cancel")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:receive")
  @Idempotent("inventory.grn.cancel")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: grnIdParams, body: cancelGrnSchema })
  cancel(
    @Param("grnId", ParseIntPipe) grnId: number,
    @Body() body: CancelGrnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grns.cancelGrn(u.orgId, grnId, u.userId, body);
  }

  @Post(":grnId/reverse")
  @ResponseSchema(reverseGrnResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:receive")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: grnIdParams, body: reverseGrnSchema })
  reverse(
    @Param("grnId", ParseIntPipe) grnId: number,
    @Body() body: ReverseGrnInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grns.reverseGrn(u.orgId, grnId, u.userId, idempotencyKey, body);
  }
}
