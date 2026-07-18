import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { BillingService } from "./billing.service";
import { MarketplaceService } from "./marketplace.service";
import { AiCreditsService } from "./ai-credits.service";
import { RazorpayService } from "./razorpay.service";
import { AffiliateService } from "./affiliate.service";
import { ReferralService } from "./referral.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { EnterpriseQuotesService } from "./enterprise-quotes.service";
import { PlanLimitsService } from "./plan-limits.service";
import {
  createCouponSchema,
  createOrderSchema,
  purchaseAddonSchema,
  updateBillingProfileSchema,
  updateCouponSchema,
  verifyPaymentSchema,
  planSchema,
  type CreateCouponInput,
  type CreateOrderInput,
  type Plan,
  type PurchaseAddonInput,
  type UpdateBillingProfileInput,
  type UpdateCouponInput,
  type VerifyPaymentInput,
} from "./dto/billing.schemas";
import { autoTopUpSchema, listTransactionsSchema, purchaseAiPackSchema, type PurchaseAiPackInput } from "./dto/ai-credits.schemas";
import { createReferralSchema } from "./dto/affiliate.schemas";
import { analyticsQuerySchema } from "./dto/analytics.schemas";
import {
  listEnterpriseQuotesSchema,
  createEnterpriseQuoteSchema,
  approveEnterpriseQuoteSchema,
  rejectEnterpriseQuoteSchema,
  type ListEnterpriseQuotesQuery,
  type CreateEnterpriseQuoteInput,
  type ApproveEnterpriseQuoteInput,
  type RejectEnterpriseQuoteInput,
} from "./dto/enterprise-quotes.schemas";

@Controller("billing")
@UseGuards(JwtAuthGuard)
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly marketplace: MarketplaceService,
    private readonly aiCredits: AiCreditsService,
    private readonly razorpay: RazorpayService,
    private readonly affiliate: AffiliateService,
    private readonly referral: ReferralService,
    private readonly analytics: RevenueAnalyticsService,
    private readonly enterpriseQuotes: EnterpriseQuotesService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  @UseGuards(PermissionGuard)
  @RequirePermission("settings:view")
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
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  checkout(
    @Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.createOrder(u.orgId, u.userId, body.plan, body.billingCycle, body.couponId);
  }

  @Post("addons/purchase")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  purchaseAddon(
    @Body(new ZodValidationPipe(purchaseAddonSchema)) body: PurchaseAddonInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.purchaseAddon(u.orgId, u.userId, body.addonId, body.quantity);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission("settings:view")
  @Get("summary")
  getSummary(@CurrentUser() u: CurrentUserContext) {
    return this.billing.getSummary(u.orgId);
  }

  @Get("entitlements")
  getEntitlements(@CurrentUser() u: CurrentUserContext) {
    return this.planLimits.getEntitlements(u.orgId);
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

  @UseGuards(PermissionGuard)
  @RequirePermission("settings:view")
  @Get("razorpay")
  getRazorpaySubscription(@CurrentUser() u: CurrentUserContext) {
    return this.billing.getSubscription(u.orgId);
  }

  @Post("razorpay")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  createOrder(
    @Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.createOrder(u.orgId, u.userId, body.plan, body.billingCycle, body.couponId);
  }

  @Patch("razorpay")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  verifyPayment(
    @Body(new ZodValidationPipe(verifyPaymentSchema)) body: VerifyPaymentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.verifyAndActivate(u.orgId, u.userId, body);
  }

  @Get("marketplace/apps")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:marketplace:view")
  listApps(@CurrentUser() u: CurrentUserContext) {
    return this.marketplace.listApps(parseInt(u.orgId, 10));
  }

  @Post("marketplace/:appId/install")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:marketplace:install")
  installApp(
    @Param("appId", ParseIntPipe) appId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.marketplace.installApp(parseInt(u.orgId, 10), parseInt(u.userId, 10), appId);
  }

  @Delete("marketplace/:appId/install")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:marketplace:install")
  uninstallApp(
    @Param("appId", ParseIntPipe) appId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.marketplace.uninstallApp(parseInt(u.orgId, 10), appId);
  }

  @Post("marketplace/:appId/trial")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:marketplace:install")
  startTrial(
    @Param("appId", ParseIntPipe) appId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.marketplace.startAppTrial(parseInt(u.orgId, 10), parseInt(u.userId, 10), appId);
  }

  @Get("ai-credits")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:ai-credits:view")
  async getAiCredits(@CurrentUser() u: CurrentUserContext) {
    const [wallet, packs] = await Promise.all([
      this.aiCredits.getWallet(u.orgId),
      this.aiCredits.listPacks(),
    ]);
    return { ...wallet, packs };
  }

  @Get("ai-credits/transactions")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:ai-credits:view")
  listAiCreditTransactions(
    @Query(new ZodValidationPipe(listTransactionsSchema)) query: ReturnType<typeof listTransactionsSchema.parse>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.aiCredits.listTransactions(u.orgId, query.page, query.limit);
  }

  @Post("ai-credits/auto-topup")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:ai-credits:purchase")
  async configureAutoTopUp(
    @Body(new ZodValidationPipe(autoTopUpSchema)) body: ReturnType<typeof autoTopUpSchema.parse>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.aiCredits.updateAutoTopUp(
      u.orgId,
      body.enabled,
      body.packId,
      body.threshold,
    );
  }

  @Post("ai-credits/purchase")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:ai-credits:purchase")
  async purchaseAiCredits(
    @Body(new ZodValidationPipe(purchaseAiPackSchema)) body: PurchaseAiPackInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (body.paymentId) {
      const valid = this.razorpay.verifyPaymentSignature(
        body.orderId ?? "",
        body.paymentId,
        body.signature ?? "",
      );
      if (!valid) throw new BadRequestException("Invalid payment signature");
      return this.aiCredits.purchaseCreditsDirectly(u.orgId, u.userId, body.packId, false, body.paymentId);
    }
    if (this.razorpay.isConfigured()) {
      return this.billing.purchaseAddon(u.orgId, u.userId, `ai_pack_${body.packId}`, 1);
    }
    return this.aiCredits.purchaseCreditsDirectly(u.orgId, u.userId, body.packId);
  }

  @Get("profile")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  getBillingProfile(@CurrentUser() u: CurrentUserContext) {
    return this.billing.getBillingProfile(u.orgId);
  }

  @Patch("profile")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:profile:update")
  updateBillingProfile(
    @Body(new ZodValidationPipe(updateBillingProfileSchema)) body: UpdateBillingProfileInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.billing.updateBillingProfile(u.orgId, body);
  }

  @Get("seats")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  getSeatInfo(@CurrentUser() u: CurrentUserContext) {
    return this.billing.getSeatInfo(u.orgId);
  }

  @Post("affiliate/register")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:affiliate:manage")
  registerAffiliate(@CurrentUser() u: CurrentUserContext) {
    return this.affiliate.register(parseInt(u.userId, 10), parseInt(u.orgId, 10));
  }

  @Get("affiliate")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:affiliate:manage")
  getAffiliateDashboard(@CurrentUser() u: CurrentUserContext) {
    return this.affiliate.getDashboard(parseInt(u.userId, 10));
  }

  @Post("affiliate/payout-request")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:affiliate:manage")
  requestAffiliatePayoutRequest(@CurrentUser() u: CurrentUserContext) {
    return this.billing.requestAffiliatePayoutRequest(u.orgId);
  }

  @Post("referrals")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  async createReferral(
    @Body(new ZodValidationPipe(createReferralSchema)) body: ReturnType<typeof createReferralSchema.parse>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.referral.createReferral(parseInt(u.orgId, 10), parseInt(u.userId, 10), body.email);
  }

  @Get("referrals")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  listReferrals(@CurrentUser() u: CurrentUserContext) {
    return this.referral.listReferrals(parseInt(u.orgId, 10));
  }

  @Get("analytics")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:analytics:view")
  async getAnalytics(@Query(new ZodValidationPipe(analyticsQuerySchema)) query: ReturnType<typeof analyticsQuerySchema.parse>) {
    const [metrics, timeSeries] = await Promise.all([
      this.analytics.getMetrics(),
      this.analytics.getTimeSeriesData(query.period),
    ]);
    return { metrics, timeSeries };
  }

  @Get("enterprise-quotes")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:enterprise-quotes:view")
  listEnterpriseQuotes(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListEnterpriseQuotesQuery,
  ) {
    const parsed = listEnterpriseQuotesSchema.parse(query);
    return this.enterpriseQuotes.list(u.orgId, parsed);
  }

  @Post("enterprise-quotes")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:enterprise-quotes:create")
  createEnterpriseQuote(
    @Body(new ZodValidationPipe(createEnterpriseQuoteSchema)) body: CreateEnterpriseQuoteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.enterpriseQuotes.create(u.orgId, u.userId, body);
  }

  @Get("enterprise-quotes/:quoteId")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:enterprise-quotes:view")
  getEnterpriseQuote(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.enterpriseQuotes.findOne(u.orgId, quoteId);
  }

  @Post("enterprise-quotes/:quoteId/submit")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:enterprise-quotes:create")
  submitEnterpriseQuote(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.enterpriseQuotes.submit(u.orgId, quoteId);
  }

  @Post("enterprise-quotes/:quoteId/approve")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:enterprise-quotes:approve")
  approveEnterpriseQuote(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @Body(new ZodValidationPipe(approveEnterpriseQuoteSchema)) body: ApproveEnterpriseQuoteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.enterpriseQuotes.approve(u.orgId, quoteId, u.userId, body);
  }

  @Post("enterprise-quotes/:quoteId/reject")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:enterprise-quotes:approve")
  rejectEnterpriseQuote(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @Body(new ZodValidationPipe(rejectEnterpriseQuoteSchema)) body: RejectEnterpriseQuoteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.enterpriseQuotes.reject(u.orgId, quoteId, u.userId, body);
  }

  @Post("enterprise-quotes/:quoteId/send")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:enterprise-quotes:approve")
  sendEnterpriseQuote(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.enterpriseQuotes.send(u.orgId, quoteId);
  }

  @Post("enterprise-quotes/:quoteId/accept")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:enterprise-quotes:view")
  acceptEnterpriseQuote(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.enterpriseQuotes.accept(u.orgId, quoteId);
  }

  @Get("addons")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:marketplace:view")
  listAddons() {
    return this.billing.listAddons();
  }

  @Get("coupons")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  listCoupons(@CurrentUser() u: CurrentUserContext) {
    return this.billing.listCoupons(u.orgId);
  }

  @Post("coupons")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  createCoupon(@Body(new ZodValidationPipe(createCouponSchema)) body: CreateCouponInput) {
    return this.billing.createCoupon(body);
  }

  @Patch("coupons/:couponId")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  updateCoupon(
    @Param("couponId", ParseIntPipe) couponId: number,
    @Body(new ZodValidationPipe(updateCouponSchema)) body: UpdateCouponInput,
  ) {
    return this.billing.updateCoupon(couponId, body);
  }

  @Delete("coupons/:couponId")
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:manage")
  deleteCoupon(@Param("couponId", ParseIntPipe) couponId: number) {
    return this.billing.deleteCoupon(couponId);
  }
}
