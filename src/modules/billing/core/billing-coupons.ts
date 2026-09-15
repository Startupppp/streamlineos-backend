import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { coupons, couponRedemptions } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { type DbOrTx } from "../../../common/rbac/access-invalidate";
import {
  evaluateCoupon,
  COUPON_NOT_FOUND,
  planBaseAmountPaise,
  type CouponEvaluation,
} from "./coupon-pricing";
import { ANNUAL_DISCOUNT_PCT } from "./plan-entitlements.constants";
import {
  type BillingCycle,
  type CreateCouponInput,
  type Plan,
  type UpdateCouponInput,
} from "./dto/billing.schemas";
import { isUniqueViolation } from "../../../common/db/postgres-error";

export type CouponReservation =
  | { reserved: true; couponId: number; discountAmountMinor: number }
  | { reserved: false; reason: string };

// A coupon is redeemable by the organisation that owns it, or by everyone when it is a
// platform-wide coupon (`org_id IS NULL`). Every read applies this predicate.
function redeemableBy(orgId: string) {
  return or(isNull(coupons.orgId), eq(coupons.orgId, orgId));
}

@Injectable()
export class BillingCoupons {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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

  async reserve(
    tx: DbOrTx,
    couponId: number,
    orgId: string,
    plan: Plan,
    baseAmountMinor: number,
  ): Promise<CouponReservation> {
    const evaluation = await this.evaluate(couponId, orgId, plan, baseAmountMinor);
    if (!evaluation.eligible) return { reserved: false, reason: evaluation.reason };

    const rows = await tx
      .update(coupons)
      .set({ usedCount: sql`${coupons.usedCount} + 1`, updatedAt: new Date() })
      .where(
        and(
          eq(coupons.id, couponId),
          eq(coupons.isActive, true),
          redeemableBy(orgId),
          or(isNull(coupons.maxUses), sql`${coupons.usedCount} < ${coupons.maxUses}`),
        ),
      )
      .returning({ id: coupons.id });

    if (!rows[0]) return { reserved: false, reason: "Coupon is no longer available" };
    return { reserved: true, couponId, discountAmountMinor: evaluation.discountAmount };
  }

  async release(tx: DbOrTx, couponId: number): Promise<void> {
    await tx
      .update(coupons)
      .set({ usedCount: sql`GREATEST(${coupons.usedCount} - 1, 0)`, updatedAt: new Date() })
      .where(eq(coupons.id, couponId));
  }

  async redeem(
    tx: DbOrTx,
    couponId: number,
    orgId: string,
    userId: string,
    amountMinor: number,
  ): Promise<void> {
    await tx.insert(couponRedemptions).values({
      couponId,
      orgId,
      userId,
      amountPaise: amountMinor,
    });
  }

  async validate(
    code: string,
    orgId: string,
    plan: Plan,
    billingCycle: BillingCycle = "monthly",
  ): Promise<{
    valid: boolean;
    couponId: number | null;
    type: "PERCENTAGE" | "FIXED" | null;
    value: number | null;
    discountAmount: number | null;
    message: string;
  }> {
    const normalizedCode = code.trim().toUpperCase();
    // `code` is unique per tenant and unique among platform coupons, but not across the
    // two, so an organisation may own a code that also exists platform-wide. Its own
    // coupon wins: `org_id IS NULL` sorts false-before-true, putting the tenant row first.
    const coupon = await this.db.query.coupons.findFirst({
      where: and(
        eq(coupons.code, normalizedCode),
        eq(coupons.isActive, true),
        redeemableBy(orgId),
      ),
      orderBy: [asc(sql`${coupons.orgId} IS NULL`), asc(coupons.id)],
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

    const baseAmountPaise = planBaseAmountPaise(plan, billingCycle, ANNUAL_DISCOUNT_PCT);
    const evaluation = await this.evaluate(
      coupon.id,
      orgId,
      plan,
      baseAmountPaise,
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

  async listRedeemable(orgId: string) {
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

  async listPlatform(page: number, limit: number) {
    const safeLimit = Math.min(limit, 100);
    const offset = Math.max(0, (page - 1) * safeLimit);
    return this.db.query.coupons.findMany({
      where: isNull(coupons.orgId),
      orderBy: (c, { desc: d }) => [d(c.createdAt)],
      limit: safeLimit,
      offset,
    });
  }

  async create(data: CreateCouponInput) {
    try {
      const [created] = await this.db
        .insert(coupons)
        .values({
          orgId: null,
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
      if (isUniqueViolation(err)) {
        throw new ConflictException("A platform promotion with this code already exists");
      }
      throw err;
    }
  }

  async update(id: number, data: UpdateCouponInput) {
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
      .where(and(eq(coupons.id, id), isNull(coupons.orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Platform promotion not found");
    return updated;
  }

  async remove(id: number) {
    const [removed] = await this.db
      .update(coupons)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(coupons.id, id), isNull(coupons.orgId)))
      .returning({ id: coupons.id });
    if (!removed) throw new NotFoundException("Platform promotion not found");
    return { success: true };
  }

  /**
   * Atomically increments `used_count` only when the limit has not been reached.
   *
   * Returns `true` when the slot was reserved (1 row affected), `false` when
   * `used_count >= max_uses` (0 rows affected — the caller must reject).
   *
   * LANE-B call site in `verifyAndActivate` (inside the activation transaction):
   *   const reserved = await this.couponAdmin.atomicConsumeMaxUses(tx, couponId);
   *   if (!reserved) throw new BadRequestException("This coupon has reached its usage limit");
   */
  async atomicConsumeMaxUses(tx: DbOrTx, couponId: number): Promise<boolean> {
    const result = await tx
      .update(coupons)
      .set({ usedCount: sql`${coupons.usedCount} + 1`, updatedAt: new Date() })
      .where(
        and(
          eq(coupons.id, couponId),
          or(
            isNull(coupons.maxUses),
            sql`${coupons.usedCount} < ${coupons.maxUses}`,
          ),
        ),
      )
      .returning({ id: coupons.id });
    return result.length > 0;
  }
}
