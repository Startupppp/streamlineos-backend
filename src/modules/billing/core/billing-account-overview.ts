import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { invoices, subscriptions } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { PlanLimitsService } from "./plan-limits.service";
import { seatInvitationCount, seatMemberCount } from "./seat-definition";
import { PlatformMerchantService } from "../payments/platform-merchant.service";

@Injectable()
export class BillingAccountOverview {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly planLimits: PlanLimitsService,
    private readonly platformMerchant: PlatformMerchantService,
  ) {}

  async getSubscription(orgId: string) {
    const subscription = await this.db.query.subscriptions.findFirst({
      where: eq(subscriptions.orgId, orgId),
      columns: {
        provider: false,
        providerSubscriptionRef: false,
        providerCustomerRef: false,
        providerPlanRef: false,
      },
      with: {
        payments: {
          limit: 5,
          orderBy: (payment, { desc: descending }) => [
            descending(payment.createdAt),
          ],
          columns: {
            provider: false,
            providerPaymentRef: false,
            providerOrderRef: false,
          },
        },
      },
    });

    const readiness = this.platformMerchant.readiness();
    return {
      subscription: subscription ?? null,
      publicKeyId: readiness.configured ? readiness.publicKeyId : null,
      isConfigured: readiness.configured,
      platformCheckout: readiness,
    };
  }

  async getSeatInfo(orgId: string) {
    // The seat definition admission enforces, not a copy of it (BUG-HRMS-001).
    const [{ seatLimit }, counts] = await Promise.all([
      this.planLimits.getEntitlements(orgId),
      this.db.execute(sql`
        SELECT ${seatMemberCount(orgId)} AS members, ${seatInvitationCount(orgId)} AS invitations
      `),
    ]);

    const activeMembers = Number(counts[0]?.["members"] ?? 0);
    const pendingInvitations = Number(counts[0]?.["invitations"] ?? 0);
    const used = activeMembers + pendingInvitations;

    return {
      total: seatLimit,
      used,
      available: seatLimit === null ? null : Math.max(0, seatLimit - used),
      activeMembers,
      pendingInvitations,
    };
  }

  async requestAffiliatePayoutRequest(orgId: string) {
    const affiliate = await this.db.query.affiliates.findFirst({
      where: (table, { eq: equals }) => equals(table.orgId, orgId),
    });
    if (!affiliate) throw new NotFoundException("Affiliate not found");
    if (affiliate.pendingPayout === 0) {
      throw new BadRequestException("No pending payout available");
    }

    return {
      success: true,
      amount: affiliate.pendingPayout,
      message:
        "Payout request submitted. Our team will process it within 5-7 business days.",
    };
  }

  async getSummary(orgId: string) {
    const [subscription, invoiceStats] = await Promise.all([
      this.db.query.subscriptions.findFirst({
        where: eq(subscriptions.orgId, orgId),
        columns: {
          plan: true,
          status: true,
          trialEndsAt: true,
          currentPeriodEnd: true,
        },
      }),
      this.db
        .select({
          totalPaid: sql<string>`coalesce(sum(case when ${invoices.status} = 'PAID' then ${invoices.total}::numeric else 0 end), 0)::text`,
          totalOutstanding: sql<string>`coalesce(sum(case when ${invoices.status} in ('ISSUED','FAILED') then ${invoices.total}::numeric else 0 end), 0)::text`,
          draft: sql<number>`count(case when ${invoices.status} = 'DRAFT' then 1 end)::int`,
          issued: sql<number>`count(case when ${invoices.status} = 'ISSUED' then 1 end)::int`,
          paid: sql<number>`count(case when ${invoices.status} = 'PAID' then 1 end)::int`,
          failed: sql<number>`count(case when ${invoices.status} = 'FAILED' then 1 end)::int`,
          voided: sql<number>`count(case when ${invoices.status} = 'VOIDED' then 1 end)::int`,
        })
        .from(invoices)
        .where(eq(invoices.orgId, orgId)),
    ]);

    const trialDaysRemaining =
      subscription?.status === "TRIAL" && subscription.trialEndsAt
        ? Math.max(
            0,
            Math.ceil(
              (new Date(subscription.trialEndsAt).getTime() - Date.now()) /
                86_400_000,
            ),
          )
        : null;

    return {
      subscription: subscription
        ? {
            plan: subscription.plan,
            status: subscription.status,
            trialEndsAt: subscription.trialEndsAt ?? null,
            trialDaysRemaining,
            currentPeriodEnd: subscription.currentPeriodEnd ?? null,
            isActive: subscription.status === "ACTIVE",
            isTrial: subscription.status === "TRIAL",
          }
        : null,
      invoiceStats: invoiceStats[0] ?? {
        totalPaid: "0",
        totalOutstanding: "0",
        draft: 0,
        issued: 0,
        paid: 0,
        failed: 0,
        voided: 0,
      },
      isConfigured: this.platformMerchant.readiness().configured,
    };
  }
}
