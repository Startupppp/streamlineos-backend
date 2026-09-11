import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { bonuses, users, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateBonusInput, PatchBonusInput } from "./dto/payroll.schemas";
import { buildCursorPage } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import {
  decodePayrollTimestampCursor,
  payrollCursorPosition,
} from "../payroll-cursor";

export type UpdateBonusResult =
  | { ok: false; reason: "not_found" | "already_paid" | "rejected_to_paid" }
  | { ok: true; bonus: typeof bonuses.$inferSelect };

@Injectable()
export class BonusesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listBonuses(
    orgId: string,
    membershipId: number | null,
    isAdmin: boolean,
    cursor?: string,
    limit = 100,
  ) {
    if (!isAdmin && membershipId === null) throw new ForbiddenException("Organization membership required");
    const cap = Math.min(limit, 100);
    const cursorScope = ["bonuses", orgId, isAdmin, membershipId] as const;
    const position = decodePayrollTimestampCursor(cursor, cursorScope);
    const conditions = [isAdmin
      ? eq(bonuses.orgId, orgId)
      : and(eq(bonuses.orgId, orgId), eq(bonuses.userMembershipId, membershipId ?? 0))];
    if (position) {
      conditions.push(
        keysetBeforeId(bonuses.createdAt, bonuses.id, {
          sortValue: position.createdAt,
          id: String(position.id),
        }),
      );
    }
    const rows = await this.db
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
      .where(and(...conditions))
      .orderBy(desc(bonuses.createdAt), desc(bonuses.id))
      .limit(cap + 1);

    return buildCursorPage(rows, cap, (row) =>
      payrollCursorPosition(cursorScope, [row.createdAt.toISOString()], row.id),
    );
  }

  async createBonus(orgId: string, body: CreateBonusInput) {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, body.userId)),
      columns: { id: true },
    });
    if (!member) throw new ForbiddenException("Employee is not a member of this organization");

    const [record] = await this.db
      .insert(bonuses)
      .values({
        orgId,
        userId: body.userId,
        userMembershipId: member.id,
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
      .where(and(eq(bonuses.id, bonusId), eq(bonuses.orgId, orgId)))
      .limit(1);

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
