import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { Universal } from "../../../common/auth/universal.decorator";
import { AllowNoOrg } from "../../../common/auth/allow-no-org.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { BillingService } from "./billing.service";
import { PlanLimitsService } from "./plan-limits.service";
import {
  confirmCheckoutSchema,
  createCouponSchema,
  createOrderSchema,
  purchaseAddonSchema,
  updateBillingProfileSchema,
  updateCouponSchema,
  validateCouponQuerySchema,
  type ConfirmCheckoutInput,
  type CreateCouponInput,
  type CreateOrderInput,
  type PurchaseAddonInput,
  type UpdateBillingProfileInput,
  type UpdateCouponInput,
  type ValidateCouponQueryInput,
} from "./dto/billing.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  billingEntitlementsResponseSchema,
  billingSeatsResponseSchema,
  billingSummaryResponseSchema,
} from "./dto/billing-response-schema";
import {
  subscriptionResponseSchema,
  plansResponseSchema,
  marketplaceOverviewResponseSchema,
  checkoutResponseSchema,
  verifyActivateResponseSchema,
  purchaseAddonResponseSchema,
  provisioningFailuresResponseSchema,
  validateCouponResponseSchema,
  billingProfileResponseSchema,
  listAddonsResponseSchema,
  couponListResponseSchema,
  couponRowSchema,
  successSchema,
} from "./dto/billing-core-response.schemas";
import { z } from "zod";

const couponIdParams = z.object({ couponId: z.coerce.number().int().positive() }).strict();

@Controller("billing")
@UseGuards(JwtAuthGuard)
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  @UseGuards(PermissionGuard)
  @RequirePermission("billing:subscription:view")
  @Get()
  @ResponseSchema(subscriptionResponseSchema)
  getSubscription(@CurrentUser() u: CurrentUserContext) {
    return this.billing.getSubscription(u.orgId);
  }

  @AllowNoOrg()
  @Get("plans")
  @Universal()
  @ResponseSchema(plansResponseSchema)
  getPlans() {
    return this.billing.getPlans();
  }

  @Get("marketplace")
  @Universal()
  @ResponseSchema(marketplaceOverviewResponseSchema)
  getMarketplace() {
    return this.billing.getMarketplace();
  }

  @Post("checkout")
  @UseGuards(RateLimitGuard, PermissionGuard)
  @UseRateLimit("billing:checkout")
  @Idempotent("billing.checkout")
  @HttpCode(200)
  @RequirePermission("billing:subscription:manage")
  @Validate({ body: createOrderSchema })
  @ResponseSchema(checkoutResponseSchema)
  checkout(
    @Body() body: CreateOrderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.createOrder(u.orgId, u.userId, body.plan, body.billingCycle, body.couponId);
  }

  @Patch("checkout")
  @Idempotent("billing.subscription.verify")
  @HttpCode(200)
  @UseGuards(RateLimitGuard, PermissionGuard)
  @UseRateLimit("billing:confirm")
  @RequirePermission("billing:subscription:manage")
  @Validate({ body: confirmCheckoutSchema })
  @ResponseSchema(verifyActivateResponseSchema)
  confirmCheckout(
    @Body() body: ConfirmCheckoutInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.verifyAndActivate(u.orgId, u.userId, body);
  }

  @Post("addons/purchase")
  @Idempotent("billing.addon.purchase")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:subscription:manage")
  @Validate({ body: purchaseAddonSchema })
  @ResponseSchema(purchaseAddonResponseSchema)
  purchaseAddon(
    @Body() body: PurchaseAddonInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.purchaseAddon(u.orgId, body.addonId, body.quantity);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission("billing:subscription:view")
  @Get("summary")
  @ResponseSchema(billingSummaryResponseSchema)
  getSummary(@CurrentUser() u: CurrentUserContext) {
    return this.billing.getSummary(u.orgId);
  }

  @Get("entitlements")
  @ResponseSchema(billingEntitlementsResponseSchema)
  @Universal()
  getEntitlements(@CurrentUser() u: CurrentUserContext) {
    return this.planLimits.getEntitlements(u.orgId);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission("billing:subscription:view")
  @Get("provisioning-failures")
  @ResponseSchema(provisioningFailuresResponseSchema)
  listProvisioningFailures(@CurrentUser() u: CurrentUserContext) {
    return this.billing.listProvisioningFailures(u.orgId);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission("billing:subscription:manage")
  @Get("coupons/validate")
  @Validate({ query: validateCouponQuerySchema })
  @ResponseSchema(validateCouponResponseSchema)
  validateCoupon(
    @Query() query: ValidateCouponQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.validateCoupon(query.code, u.orgId, query.plan);
  }

  @Get("profile")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:profile:view")
  @ResponseSchema(billingProfileResponseSchema)
  getBillingProfile(@CurrentUser() u: CurrentUserContext) {
    return this.billing.getBillingProfile(u.orgId);
  }

  @Patch("profile")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:profile:update")
  @Validate({ body: updateBillingProfileSchema })
  @ResponseSchema(billingProfileResponseSchema)
  updateBillingProfile(
    @Body() body: UpdateBillingProfileInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.updateBillingProfile(u.orgId, body);
  }

  @Get("seats")
  @ResponseSchema(billingSeatsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:seats:view")
  getSeatInfo(@CurrentUser() u: CurrentUserContext) {
    return this.billing.getSeatInfo(u.orgId);
  }

  @Get("addons")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:marketplace:view")
  @ResponseSchema(listAddonsResponseSchema)
  listAddons() {
    return this.billing.listAddons();
  }

  @Get("coupons")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:coupons:manage")
  @ResponseSchema(couponListResponseSchema)
  listCoupons(@CurrentUser() u: CurrentUserContext) {
    return this.billing.listCoupons(u.orgId);
  }

  @Post("coupons")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:coupons:manage")
  @Validate({ body: createCouponSchema })
  @ResponseSchema(couponRowSchema)
  createCoupon(@Body() body: CreateCouponInput, @CurrentUser() u: CurrentUserContext) {
    return this.billing.createCoupon(u.orgId, body);
  }

  @Patch("coupons/:couponId")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:coupons:manage")
  @Validate({ params: couponIdParams, body: updateCouponSchema })
  @ResponseSchema(couponRowSchema)
  updateCoupon(
    @Param("couponId", ParseIntPipe) couponId: number,
    @Body() body: UpdateCouponInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.updateCoupon(u.orgId, couponId, body);
  }

  @Delete("coupons/:couponId")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:coupons:manage")
  @Validate({ params: couponIdParams })
  @ResponseSchema(successSchema)
  deleteCoupon(
    @Param("couponId", ParseIntPipe) couponId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.deleteCoupon(u.orgId, couponId);
  }
}
