import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { bonuses, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateBonusInput, PatchBonusInput } from "./dto/payroll.schemas";

export type UpdateBonusResult =
  | { ok: false; reason: "not_found" | "already_paid" | "rejected_to_paid" }
  | { ok: true; bonus: typeof bonuses.$inferSelect };

@Injectable()
export class BonusesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listBonuses(orgId: string, userId: string, isAdmin: boolean) {
    return this.db
      .select({
        id: bonuses.id,
        orgId: bonuses.orgId,
        userId: bonuses.userId,
        type: bonuses.type,
        amount: bonuses.amount,
        reason: bonuses.reason,
        month: bonuses.month,
        taxable: bonuses.taxable,
        status: bonuses.status,
        approvedBy: bonuses.approvedBy,
        approvedAt: bonuses.approvedAt,
        createdAt: bonuses.createdAt,
        userName: users.name,
        userEmail: users.email,
      })
      .from(bonuses)
      .leftJoin(users, eq(bonuses.userId, users.id))
      .where(
        isAdmin
          ? eq(bonuses.orgId, orgId)
          : and(eq(bonuses.orgId, orgId), eq(bonuses.userId, userId)),
      )
      .orderBy(desc(bonuses.createdAt))
      .limit(100);
  }

  async createBonus(orgId: string, body: CreateBonusInput) {
    const [record] = await this.db
      .insert(bonuses)
      .values({
        orgId,
        userId: body.userId,
        type: body.type,
        amount: body.amount.toString(),
        reason: body.reason ?? null,
        month: body.month,
        taxable: body.taxable ?? true,
        status: "PENDING",
      })
      .returning();
    return record;
  }

  async updateBonus(orgId: string, userId: string, bonusId: number, body: PatchBonusInput): Promise<UpdateBonusResult> {
    const [existing] = await this.db
      .select()
      .from(bonuses)
      .where(and(eq(bonuses.id, bonusId), eq(bonuses.orgId, orgId)));

    if (!existing) return { ok: false, reason: "not_found" };
    if (existing.status === "PAID") return { ok: false, reason: "already_paid" };
    if (body.status === "PAID" && existing.status === "REJECTED") return { ok: false, reason: "rejected_to_paid" };

    const [updated] = await this.db
      .update(bonuses)
      .set({ status: body.status, approvedBy: userId, approvedAt: new Date() })
      .where(and(eq(bonuses.id, bonusId), eq(bonuses.orgId, orgId)))
      .returning();

    return { ok: true, bonus: updated };
  }
}
