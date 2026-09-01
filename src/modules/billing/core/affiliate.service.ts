import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { affiliateCommissions, affiliates, organizationMembers } from "../../../db/schema";

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
    const [existing] = await this.db
      .select()
      .from(affiliates)
      .where(and(eq(affiliates.orgId, orgId), eq(affiliates.userMembershipId, membershipId)));
    if (existing) throw new ConflictException("Already registered as affiliate");

    const referralCode = generateCode();
    const [affiliate] = await this.db
      .insert(affiliates)
      .values({ userId, orgId, referralCode, status: "ACTIVE", userMembershipId: membershipId })
      .returning();
    return affiliate;
  }

  async getDashboard(userId: string, orgId: string, membershipId: number) {
    await this.assertActiveMembership(userId, orgId, membershipId);
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
      await tx
        .update(affiliates)
        .set({
          totalEarned: affiliate.totalEarned + commissionAmount,
          pendingPayout: affiliate.pendingPayout + commissionAmount,
          signupCount: affiliate.signupCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(affiliates.id, affiliate.id));
    });
  }
}
