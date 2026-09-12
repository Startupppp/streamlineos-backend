import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Optional,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { and, count, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { coupons, couponRedemptions } from "../../../db/schema";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
import { AuthorizedInService } from "../../../common/auth/authorized-in-service.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import {
  createPromotionSchema,
  updatePromotionSchema,
  promotionIdParams,
  promotionRowSchema,
  promotionListResponseSchema,
  legacyTenantCouponListResponseSchema,
  type CreatePromotionInput,
  type UpdatePromotionInput,
} from "./dto/platform-promotions.schemas";

function assertInternalSecret(secret: string | undefined, expected: string | undefined): void {
  if (!expected || secret !== expected) throw new UnauthorizedException("Invalid internal secret");
}

@Controller("platform/promotions")
export class PlatformPromotionsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional() @Inject(APP_CONFIG) private readonly config?: Pick<AppConfig, "INTERNAL_API_SECRET">,
  ) {}

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — StreamlineOS platform operator only; creates a platform-wide promotion (org_id IS NULL)",
  )
  @Post()
  @HttpCode(201)
  @Validate({ body: createPromotionSchema })
  @ResponseSchema(promotionRowSchema)
  async createPromotion(
    @Headers("x-internal-secret") secret: string | undefined,
    @Body() body: CreatePromotionInput,
  ) {
    assertInternalSecret(secret, this.config?.INTERNAL_API_SECRET);
    try {
      const [created] = await this.db
        .insert(coupons)
        .values({
          code: body.code.toUpperCase(),
          type: body.type,
          value: String(body.value),
          maxUses: body.maxUses,
          applicablePlans: body.applicablePlans,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
        })
        .returning();
      return created;
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw new ConflictException("A platform promotion with this code already exists");
      throw err;
    }
  }

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — StreamlineOS platform operator only; updates a platform-wide promotion",
  )
  @Patch(":promotionId")
  @HttpCode(200)
  @Validate({ params: promotionIdParams, body: updatePromotionSchema })
  @ResponseSchema(promotionRowSchema)
  async updatePromotion(
    @Headers("x-internal-secret") secret: string | undefined,
    @Param("promotionId", ParseIntPipe) promotionId: number,
    @Body() body: UpdatePromotionInput,
  ) {
    assertInternalSecret(secret, this.config?.INTERNAL_API_SECRET);
    const [updated] = await this.db
      .update(coupons)
      .set({
        ...(body.code !== undefined ? { code: body.code.toUpperCase() } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.value !== undefined ? { value: String(body.value) } : {}),
        ...(body.maxUses !== undefined ? { maxUses: body.maxUses } : {}),
        ...(body.applicablePlans !== undefined ? { applicablePlans: body.applicablePlans } : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: new Date(body.expiresAt) } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(coupons.id, promotionId), isNull(coupons.orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Platform promotion not found");
    return updated;
  }

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — StreamlineOS platform operator only; deactivates a platform-wide promotion",
  )
  @Delete(":promotionId")
  @HttpCode(200)
  @Validate({ params: promotionIdParams })
  @ResponseSchema(z.object({ success: z.literal(true) }))
  async deletePromotion(
    @Headers("x-internal-secret") secret: string | undefined,
    @Param("promotionId", ParseIntPipe) promotionId: number,
  ) {
    assertInternalSecret(secret, this.config?.INTERNAL_API_SECRET);
    const [removed] = await this.db
      .update(coupons)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(coupons.id, promotionId), isNull(coupons.orgId)))
      .returning({ id: coupons.id });
    if (!removed) throw new NotFoundException("Platform promotion not found");
    return { success: true as const };
  }

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — StreamlineOS platform operator only; lists all platform-wide promotions",
  )
  @Get()
  @ResponseSchema(promotionListResponseSchema)
  async listPromotions(
    @Headers("x-internal-secret") secret: string | undefined,
  ) {
    assertInternalSecret(secret, this.config?.INTERNAL_API_SECRET);
    const promotions = await this.db
      .select()
      .from(coupons)
      .where(isNull(coupons.orgId))
      .orderBy(coupons.createdAt)
      .limit(500);
    return { promotions };
  }

  @AuthorizedInService(
    "INTERNAL_API_SECRET header — StreamlineOS platform operator only; lists legacy tenant-owned coupons for reconciliation",
  )
  @Get("legacy-tenant-coupons")
  @ResponseSchema(legacyTenantCouponListResponseSchema)
  async listLegacyTenantCoupons(
    @Headers("x-internal-secret") secret: string | undefined,
  ) {
    assertInternalSecret(secret, this.config?.INTERNAL_API_SECRET);
    const rows = await this.db
      .select({
        id: coupons.id,
        code: coupons.code,
        orgId: coupons.orgId,
        type: coupons.type,
        value: coupons.value,
        usedCount: coupons.usedCount,
        maxUses: coupons.maxUses,
        isActive: coupons.isActive,
        redemptionCount: count(couponRedemptions.id),
        createdAt: coupons.createdAt,
      })
      .from(coupons)
      .leftJoin(couponRedemptions, eq(couponRedemptions.couponId, coupons.id))
      .where(isNotNull(coupons.orgId))
      .groupBy(
        coupons.id,
        coupons.code,
        coupons.orgId,
        coupons.type,
        coupons.value,
        coupons.usedCount,
        coupons.maxUses,
        coupons.isActive,
        coupons.createdAt,
      )
      .orderBy(coupons.createdAt)
      .limit(1000);
    return { coupons: rows };
  }
}
