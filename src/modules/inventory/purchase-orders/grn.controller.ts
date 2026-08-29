import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, Query, UseGuards, HttpCode, HttpStatus } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { GrnService } from "./grn.service";
import { GrnReadService } from "./grn-read.service";
import {
  listGrnSchema, reverseGrnSchema, createGrnDraftSchema, updateGrnDraftSchema, cancelGrnSchema,
  type ListGrnInput, type ReverseGrnInput, type CreateGrnDraftInput,
  type UpdateGrnDraftInput, type CancelGrnInput,
} from "./dto/inv-purchase-orders.schemas";

/**
 * B1. Receiving as a document with a life, not a single irreversible click.
 *
 * The transitions are separate routes rather than one `PATCH { status }`: each
 * is a different authority question later (quality review is the natural place
 * for a second permission when B12 makes inspection mandatory) and a status
 * field on a general update is the shape that lets a client walk a document
 * straight to POSTED past every check the lifecycle exists to impose.
 *
 * All six carry `inventory:purchase-orders:receive`, which is the live key the
 * permission map assigns to `inventory:receiving:*`. Opening a receipt and
 * posting it are not split into two keys here: nothing in the catalogue
 * expresses that distinction today and inventing a key without a backfill
 * migration leaves it held by nobody.
 */
@RequireModule("inventory")
@Controller("inventory/goods-receipts")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class GrnController {
  constructor(
    private readonly grns: GrnService,
    private readonly reads: GrnReadService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:read")
  list(
    @Query(new ZodValidationPipe(listGrnSchema)) filters: ListGrnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reads.listGrns(u.orgId, u.userId, filters);
  }

  @Get(":grnId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:read")
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
  createDraft(
    @Body(new ZodValidationPipe(createGrnDraftSchema)) body: CreateGrnDraftInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grns.createDraft(u.orgId, u.userId, idempotencyKey, body);
  }

  @Patch(":grnId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:receive")
  updateDraft(
    @Param("grnId", ParseIntPipe) grnId: number,
    @Body(new ZodValidationPipe(updateGrnDraftSchema)) body: UpdateGrnDraftInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grns.updateDraft(u.orgId, grnId, u.userId, body);
  }

  @Post(":grnId/count")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:receive")
  @HttpCode(HttpStatus.OK)
  startCounting(
    @Param("grnId", ParseIntPipe) grnId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grns.startCounting(u.orgId, grnId, u.userId);
  }

  @Post(":grnId/quality-review")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:receive")
  @HttpCode(HttpStatus.OK)
  submitForQualityReview(
    @Param("grnId", ParseIntPipe) grnId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grns.submitForQualityReview(u.orgId, grnId, u.userId);
  }

  @Post(":grnId/post")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:receive")
  @HttpCode(HttpStatus.OK)
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
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param("grnId", ParseIntPipe) grnId: number,
    @Body(new ZodValidationPipe(cancelGrnSchema)) body: CancelGrnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grns.cancelGrn(u.orgId, grnId, u.userId, body);
  }

  @Post(":grnId/reverse")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:purchase-orders:receive")
  @HttpCode(HttpStatus.OK)
  reverse(
    @Param("grnId", ParseIntPipe) grnId: number,
    @Body(new ZodValidationPipe(reverseGrnSchema)) body: ReverseGrnInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grns.reverseGrn(u.orgId, grnId, u.userId, idempotencyKey, body);
  }
}
