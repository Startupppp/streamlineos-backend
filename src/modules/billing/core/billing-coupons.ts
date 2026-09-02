import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, or } from "drizzle-orm";
import { coupons, couponRedemptions } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import {
  evaluateCoupon,
  COUPON_NOT_FOUND,
  type CouponEvaluation,
} from "./coupon-pricing";
import { PLAN_PRICES_PAISE } from "./plan-entitlements.constants";
import {
  type CreateCouponInput,
  type Plan,
  type UpdateCouponInput,
} from "./dto/billing.schemas";

// A coupon is redeemable by the organisation that owns it, or by everyone when it is a
// platform-wide coupon (`org_id IS NULL`). Every read applies this predicate.
function redeemableBy(orgId: string) {
  return or(isNull(coupons.orgId), eq(coupons.orgId, orgId));
}

// Every read goes through `evaluate`, so checkout, validation and redemption cannot disagree.
export class BillingCoupons {
  constructor(private readonly db: Db) {}

  // Advisory only: the count and redemption row are written under FOR UPDATE in verifyAndActivate.
  async evaluate(
    couponId: number,
    orgId: string,
    plan: Plan,
    baseAmountPaise: number,
  ): Promise<CouponEvaluation> {
    const coupon = await this.db.query.coupons.findFirst({
      where: and(
        eq(coupons.id, couponId),
        eq(coupons.isActive, true),
        redeemableBy(orgId),
      ),
    });
    const alreadyRedeemed = coupon
      ? await this.db.query.couponRedemptions.findFirst({
          where: and(
            eq(couponRedemptions.couponId, coupon.id),
            eq(couponRedemptions.orgId, orgId),
          ),
        })
      : undefined;

    return evaluateCoupon({
      coupon: coupon ?? undefined,
      baseAmountPaise,
      plan,
      alreadyRedeemedByOrg:
        alreadyRedeemed !== undefined && alreadyRedeemed !== null,
      now: new Date(),
    });
  }

  async validate(
    code: string,
    orgId: string,
    plan: Plan,
  ): Promise<{
    valid: boolean;
    couponId: number | null;
    type: "PERCENTAGE" | "FIXED" | null;
    value: number | null;
    discountAmount: number | null;
    message: string;
  }> {
    const normalizedCode = code.trim().toUpperCase();
    const coupon = await this.db.query.coupons.findFirst({
      where: and(
        eq(coupons.code, normalizedCode),
        eq(coupons.isActive, true),
        redeemableBy(orgId),
      ),
    });

    if (!coupon) {
      return {
        valid: false,
        couponId: null,
        type: null,
        value: null,
        discountAmount: null,
        message: COUPON_NOT_FOUND,
      };
    }

    const evaluation = await this.evaluate(
      coupon.id,
      orgId,
      plan,
      PLAN_PRICES_PAISE[plan],
    );
    if (!evaluation.eligible) {
      return {
        valid: false,
        couponId: null,
        type: null,
        value: null,
        discountAmount: null,
        message: evaluation.reason,
      };
    }

    return {
      valid: true,
      couponId: evaluation.couponId,
      type: evaluation.type,
      value: evaluation.value,
      discountAmount: evaluation.discountAmount,
      message:
        evaluation.type === "PERCENTAGE"
          ? `${evaluation.value}% discount applied`
          : `₹${evaluation.value} discount applied`,
    };
  }

  async list(orgId: string) {
    const all = await this.db.query.coupons.findMany({
      where: redeemableBy(orgId),
      orderBy: (c, { desc: d }) => [d(c.createdAt)],
      with: {
        redemptions: {
          where: eq(couponRedemptions.orgId, orgId),
        },
      },
      limit: 100,
    });
    return all;
  }

  async create(orgId: string, data: CreateCouponInput) {
    try {
      const [created] = await this.db
        .insert(coupons)
        .values({
          orgId,
          code: data.code.toUpperCase(),
          type: data.type,
          value: String(data.value),
          maxUses: data.maxUses,
          applicablePlans: data.applicablePlans,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
        })
        .returning();
      return created;
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        (err as { code?: string }).code === "23505"
      ) {
        throw new ConflictException("A coupon with this code already exists");
      }
      throw err;
    }
  }

  async update(orgId: string, id: number, data: UpdateCouponInput) {
    const [updated] = await this.db
      .update(coupons)
      .set({
        ...(data.code !== undefined ? { code: data.code.toUpperCase() } : {}),
        ...(data.type !== undefined ? { type: data.type } : {}),
        ...(data.value !== undefined ? { value: String(data.value) } : {}),
        ...(data.maxUses !== undefined ? { maxUses: data.maxUses } : {}),
        ...(data.applicablePlans !== undefined
          ? { applicablePlans: data.applicablePlans }
          : {}),
        ...(data.expiresAt !== undefined
          ? { expiresAt: new Date(data.expiresAt) }
          : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(coupons.id, id), eq(coupons.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Coupon not found");
    return updated;
  }

  async remove(orgId: string, id: number) {
    const [removed] = await this.db
      .update(coupons)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(coupons.id, id), eq(coupons.orgId, orgId)))
      .returning({ id: coupons.id });
    if (!removed) throw new NotFoundException("Coupon not found");
    return { success: true };
  }
}
