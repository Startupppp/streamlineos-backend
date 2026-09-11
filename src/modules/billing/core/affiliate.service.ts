import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { affiliateCommissions, affiliates, organizationMembers } from "../../../db/schema";
import { isUniqueViolationOn } from "../../../common/db/postgres-error";

function generateCode(): string {
  return Math.random().toString(36).substring(2, 12).toUpperCase();
}

@Injectable()
export class AffiliateService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async assertActiveMembership(userId: string, orgId: string, membershipId: number): Promise<void> {
    const [membership] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.id, membershipId),
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .limit(1);
    if (!membership) throw new ForbiddenException("Active organization membership required");
  }

  async register(userId: string, orgId: string, membershipId: number) {
    await this.assertActiveMembership(userId, orgId, membershipId);
    // Guard the key the DATABASE enforces. This used to select on
    // (org_id, user_membership_id) while the constraint was a deployment-global
    // UNIQUE(user_id): a user already an affiliate in org A passed the pre-check in org B
    // and the insert raised an uncaught 23505, so the route 500'd and a person could be an
    // affiliate in exactly one organisation across the whole deployment. Migration 1055
    // moved the constraint to (org_id, user_id); this names the same key.
    const [existing] = await this.db
      .select()
      .from(affiliates)
      .where(and(eq(affiliates.orgId, orgId), eq(affiliates.userId, userId)));
    if (existing) throw new ConflictException("Already registered as affiliate");

    const referralCode = generateCode();
    try {
      const [affiliate] = await this.db
        .insert(affiliates)
        .values({ userId, orgId, referralCode, status: "ACTIVE", userMembershipId: membershipId })
        .returning();
      return affiliate;
    } catch (err: unknown) {
      // The constraint is the authority; the read above is only a fast path, and two
      // concurrent registrations can both pass it. A collision is a 409, never a 500.
      if (isUniqueViolationOn(err, "uniq_affiliates_org_user")) {
        throw new ConflictException("Already registered as affiliate");
      }
      throw err;
    }
  }

  async getDashboard(userId: string, orgId: string, membershipId: number) {
    await this.assertActiveMembership(userId, orgId, membershipId);
    // Deliberately keyed on user_membership_id, not user_id: affiliate-tenant-isolation.spec
    // pins that as a revocation property ("getDashboard scopes to membershipId, not userId")
    // and it is not this change's to move. Note the residual asymmetry with `register`, which
    // must name the key the constraint enforces: because fk_affiliates_org_user_mbr is
    // ON DELETE SET NULL, a re-created membership leaves a row that register() reports as a
    // 409 conflict while this read reports no affiliate at all.
    const [affiliate] = await this.db
      .select()
      .from(affiliates)
      .where(and(eq(affiliates.orgId, orgId), eq(affiliates.userMembershipId, membershipId)));
    if (!affiliate) return null;

    const commissions = await this.db
      .select()
      .from(affiliateCommissions)
      .where(eq(affiliateCommissions.affiliateId, affiliate.id))
      .orderBy(desc(affiliateCommissions.createdAt))
      .limit(50);

    return { affiliate, commissions };
  }

  async creditCommission(
    referralCode: string,
    referredOrgId: string,
    subscriptionId: number,
    amountInPaise: number,
  ) {
    const [affiliate] = await this.db
      .select()
      .from(affiliates)
      .where(
        and(
          eq(affiliates.referralCode, referralCode),
          eq(affiliates.status, "ACTIVE"),
        ),
      );
    if (!affiliate) return;

    const commissionAmount = Math.round(
      (amountInPaise * affiliate.commissionRate) / 100,
    );

    await this.db.transaction(async (tx) => {
      await tx.insert(affiliateCommissions).values({
        affiliateId: affiliate.id,
        referredOrgId,
        subscriptionId,
        amountInPaise: commissionAmount,
        status: "PENDING",
      });
      /*
       * Atomic increments, not JavaScript arithmetic over a row read before the
       * transaction opened. Two subscription webhooks for the same referral code
       * each inserted their own commission row but both wrote the same
       * `pendingPayout`, so the affiliate was paid for one of the two.
       */
      await tx
        .update(affiliates)
        .set({
          totalEarned: sql`${affiliates.totalEarned} + ${commissionAmount}`,
          pendingPayout: sql`${affiliates.pendingPayout} + ${commissionAmount}`,
          signupCount: sql`${affiliates.signupCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(affiliates.id, affiliate.id));
    });
  }
}
