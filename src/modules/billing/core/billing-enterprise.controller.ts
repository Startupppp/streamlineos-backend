import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { BillingService } from "./billing.service";
import { AffiliateService } from "./affiliate.service";
import { ReferralService } from "./referral.service";
import { RevenueAnalyticsService } from "./revenue-analytics.service";
import { EnterpriseQuotesService } from "./enterprise-quotes.service";
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
import { createReferralSchema } from "./dto/affiliate.schemas";
import { analyticsQuerySchema } from "./dto/analytics.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";

const quoteIdParams = z.object({ quoteId: z.coerce.number().int().positive() }).strict();

@Controller("billing")
@UseGuards(JwtAuthGuard)
export class BillingEnterpriseController {
  constructor(
    private readonly billing: BillingService,
    private readonly affiliate: AffiliateService,
    private readonly referral: ReferralService,
    private readonly analytics: RevenueAnalyticsService,
    private readonly enterpriseQuotes: EnterpriseQuotesService,
  ) {}

  @Post("affiliate/register")
  @Idempotent("billing.affiliate.register")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:affiliate:manage")
  registerAffiliate(@CurrentUser() u: CurrentUserContext) {
    return this.affiliate.register(u.userId, u.orgId);
  }

  @Get("affiliate")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:affiliate:manage")
  getAffiliateDashboard(@CurrentUser() u: CurrentUserContext) {
    return this.affiliate.getDashboard(u.userId);
  }

  @Post("affiliate/payout-request")
  @Idempotent("billing.affiliate.payout-request")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:affiliate:manage")
  requestAffiliatePayoutRequest(@CurrentUser() u: CurrentUserContext) {
    return this.billing.requestAffiliatePayoutRequest(u.orgId);
  }

  @Post("referrals")
  @Idempotent("billing.referral.create")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:referrals:manage")
  @Validate({ body: createReferralSchema })
  async createReferral(
    @Body() body: ReturnType<typeof createReferralSchema.parse>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.referral.createReferral(u.orgId, u.userId, body.email);
  }

  @Get("referrals")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:referrals:view")
  listReferrals(@CurrentUser() u: CurrentUserContext) {
    return this.referral.listReferrals(u.orgId);
  }

  @Get("analytics")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:analytics:view")
  @Validate({ query: analyticsQuerySchema })
  async getAnalytics(@Query() query: ReturnType<typeof analyticsQuerySchema.parse>) {
    const [metrics, timeSeries] = await Promise.all([
      this.analytics.getMetrics(),
      this.analytics.getTimeSeriesData(query.period),
    ]);
    return { metrics, timeSeries };
  }

  @Get("enterprise-quotes")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:enterprise-quotes:view")
  @Validate({ query: listEnterpriseQuotesSchema })
  listEnterpriseQuotes(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListEnterpriseQuotesQuery,
  ) {
    return this.enterpriseQuotes.list(u.orgId, query);
  }

  @Post("enterprise-quotes")
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:enterprise-quotes:create")
  @Validate({ body: createEnterpriseQuoteSchema })
  createEnterpriseQuote(
    @Body() body: CreateEnterpriseQuoteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.enterpriseQuotes.create(u.orgId, u.userId, body);
  }

  @Get("enterprise-quotes/:quoteId")
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:enterprise-quotes:view")
  @Validate({ params: quoteIdParams })
  getEnterpriseQuote(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.enterpriseQuotes.findOne(u.orgId, quoteId);
  }

  @Post("enterprise-quotes/:quoteId/submit")
  @Idempotent("billing.enterprise-quote.submit")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:enterprise-quotes:create")
  @Validate({ params: quoteIdParams })
  submitEnterpriseQuote(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.enterpriseQuotes.submit(u.orgId, quoteId);
  }

  @Post("enterprise-quotes/:quoteId/approve")
  @Idempotent("billing.enterprise-quote.approve")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:enterprise-quotes:approve")
  @Validate({ params: quoteIdParams, body: approveEnterpriseQuoteSchema })
  approveEnterpriseQuote(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @Body() body: ApproveEnterpriseQuoteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.enterpriseQuotes.approve(u.orgId, quoteId, u.userId, body);
  }

  @Post("enterprise-quotes/:quoteId/reject")
  @Idempotent("billing.enterprise-quote.reject")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:enterprise-quotes:approve")
  @Validate({ params: quoteIdParams, body: rejectEnterpriseQuoteSchema })
  rejectEnterpriseQuote(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @Body() body: RejectEnterpriseQuoteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.enterpriseQuotes.reject(u.orgId, quoteId, u.userId, body);
  }

  @Post("enterprise-quotes/:quoteId/send")
  @Idempotent("billing.enterprise-quote.send")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:enterprise-quotes:approve")
  @Validate({ params: quoteIdParams })
  @BodylessAction()
  sendEnterpriseQuote(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.enterpriseQuotes.send(u.orgId, quoteId);
  }

  @Post("enterprise-quotes/:quoteId/accept")
  @Idempotent("billing.enterprise-quote.accept")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("billing:enterprise-quotes:view")
  @Validate({ params: quoteIdParams })
  @BodylessAction()
  acceptEnterpriseQuote(
    @Param("quoteId", ParseIntPipe) quoteId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.enterpriseQuotes.accept(u.orgId, quoteId);
  }
}
