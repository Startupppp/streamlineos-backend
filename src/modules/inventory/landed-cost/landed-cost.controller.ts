import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { LandedCostService } from "./landed-cost.service";
import { LandedCostApplyService } from "./landed-cost-apply.service";
import {
  addLandedCostChargeSchema,
  createLandedCostVoucherSchema,
  listLandedCostVouchersSchema,
  type AddLandedCostChargeInput,
  type CreateLandedCostVoucherInput,
  type ListLandedCostVouchersInput,
} from "./dto/landed-cost.schemas";

/**
 * G5 — landed cost as a document with a life.
 *
 * Reads are gated on `inventory:valuation:read`, the key that already governs
 * "may this person see what stock cost", because that is exactly what a landed
 * cost voucher discloses: supplier freight is commercially sensitive and the
 * warehouse floor has no business with it.
 *
 * Writes carry `inventory:landed-cost:manage`, a new key rather than a borrowed
 * one. `inventory:purchase-orders:receive` is held by every receiving clerk in
 * the organisation and applying a voucher changes what inventory is worth and
 * posts to the general ledger — those are different authorities and collapsing
 * them would let anyone who can sign for a pallet restate the balance sheet. The
 * key ships with a backfill migration (0572), without which a template addition
 * reaches new organisations only and every route here would 403 everywhere else.
 */
@RequireModule("inventory")
@Controller("inventory/landed-cost")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class LandedCostController {
  constructor(
    private readonly vouchers: LandedCostService,
    private readonly apply: LandedCostApplyService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:valuation:read")
  list(
    @Query(new ZodValidationPipe(listLandedCostVouchersSchema)) filters: ListLandedCostVouchersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vouchers.listVouchers(u.orgId, u.userId, filters);
  }

  @Get(":voucherId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:valuation:read")
  get(
    @Param("voucherId", ParseIntPipe) voucherId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vouchers.getVoucher(u.orgId, u.userId, voucherId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:landed-cost:manage")
  create(
    @Body(new ZodValidationPipe(createLandedCostVoucherSchema)) body: CreateLandedCostVoucherInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vouchers.createVoucher(u.orgId, u.userId, body, idempotencyKey);
  }

  @Post(":voucherId/charges")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:landed-cost:manage")
  addCharge(
    @Param("voucherId", ParseIntPipe) voucherId: number,
    @Body(new ZodValidationPipe(addLandedCostChargeSchema)) body: AddLandedCostChargeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vouchers.addCharge(u.orgId, u.userId, voucherId, body);
  }

  /**
   * The only route here that moves money. Idempotent on the caller's key,
   * because a retried apply that ran twice would put the freight into the cost
   * layers twice and there is no movement to reverse it with.
   */
  @Post(":voucherId/apply")
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:landed-cost:manage")
  applyVoucher(
    @Param("voucherId", ParseIntPipe) voucherId: number,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.apply.applyVoucher(u.orgId, u.userId, voucherId, idempotencyKey);
  }

  @Delete(":voucherId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:landed-cost:manage")
  remove(
    @Param("voucherId", ParseIntPipe) voucherId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.vouchers.deleteVoucher(u.orgId, u.userId, voucherId);
  }
}
