import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { referrals } from "../../db/schema";

function generateCode(): string {
  return Math.random().toString(36).substring(2, 14).toUpperCase();
}

@Injectable()
export class ReferralService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async createReferral(
    referrerOrgId: string,
    referrerUserId: string,
    email: string,
  ) {
    const [existing] = await this.db
      .select()
      .from(referrals)
      .where(
        and(
          eq(referrals.referrerOrgId, referrerOrgId),
          eq(referrals.referredEmail, email),
        ),
      );
    if (existing)
      throw new ConflictException("Referral already sent to this email");

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const [referral] = await this.db
      .insert(referrals)
      .values({
        referrerOrgId,
        referrerUserId,
        referredEmail: email,
        referralCode: generateCode(),
        status: "PENDING",
        expiresAt,
      })
      .returning();
    return referral;
  }

  async listReferrals(orgId: string) {
    return this.db
      .select()
      .from(referrals)
      .where(eq(referrals.referrerOrgId, orgId))
      .orderBy(referrals.createdAt)
      .limit(100);
  }

  async processSignup(referralCode: string, newOrgId: string) {
    const [referral] = await this.db
      .select()
      .from(referrals)
      .where(eq(referrals.referralCode, referralCode));
    if (!referral || referral.status !== "PENDING") return;

    await this.db
      .update(referrals)
      .set({
        status: "SIGNED_UP",
        referredOrgId: newOrgId,
        signedUpAt: new Date(),
      })
      .where(eq(referrals.id, referral.id));
  }

  async activateReferral(orgId: string) {
    const [referral] = await this.db
      .select()
      .from(referrals)
      .where(
        and(
          eq(referrals.referredOrgId, orgId),
          eq(referrals.status, "SIGNED_UP"),
        ),
      );
    if (!referral) return;

    await this.db
      .update(referrals)
      .set({ status: "ACTIVATED", activatedAt: new Date() })
      .where(eq(referrals.id, referral.id));
  }
}
