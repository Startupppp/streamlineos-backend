import { Body, Controller, Get, HttpCode, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { BillingService } from "./billing.service";
import {
  createOrderSchema,
  purchaseAddonSchema,
  verifyPaymentSchema,
  planSchema,
  type CreateOrderInput,
  type Plan,
  type PurchaseAddonInput,
  type VerifyPaymentInput,
} from "./dto/billing.schemas";

@Controller("billing")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  getSubscription(@CurrentUser() u: CurrentUserContext) {
    return this.billing.getSubscription(u.orgId);
  }

  @Get("plans")
  getPlans() {
    return this.billing.getPlans();
  }

  @Get("marketplace")
  getMarketplace() {
    return this.billing.getMarketplace();
  }

  @Post("checkout")
  @HttpCode(200)
  @RequirePermission("settings:manage")
  checkout(
    @Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.createOrder(u.orgId, u.userId, body.plan, body.billingCycle, body.couponId);
  }

  @Post("addons/purchase")
  @HttpCode(200)
  @RequirePermission("settings:manage")
  purchaseAddon(
    @Body(new ZodValidationPipe(purchaseAddonSchema)) body: PurchaseAddonInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.purchaseAddon(u.orgId, u.userId, body.addonId, body.quantity);
  }

  @Get("summary")
  getSummary(@CurrentUser() u: CurrentUserContext) {
    return this.billing.getSummary(u.orgId);
  }

  @Get("coupons/validate")
  validateCoupon(
    @Query("code") code: string,
    @Query("plan") plan: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const parsedPlan = planSchema.safeParse(plan);
    if (!parsedPlan.success) {
      return { valid: false, message: "Invalid plan" };
    }
    return this.billing.validateCoupon(code ?? "", u.orgId, parsedPlan.data as Plan);
  }

  @Get("razorpay")
  getRazorpaySubscription(@CurrentUser() u: CurrentUserContext) {
    return this.billing.getSubscription(u.orgId);
  }

  @Post("razorpay")
  @HttpCode(200)
  @RequirePermission("settings:manage")
  createOrder(
    @Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.createOrder(u.orgId, u.userId, body.plan, body.billingCycle, body.couponId);
  }

  @Patch("razorpay")
  @RequirePermission("settings:manage")
  verifyPayment(
    @Body(new ZodValidationPipe(verifyPaymentSchema)) body: VerifyPaymentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.verifyAndActivate(u.orgId, u.userId, body);
  }
}
