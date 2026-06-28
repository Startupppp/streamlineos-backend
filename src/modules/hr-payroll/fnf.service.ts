import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { fnfSettlements, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateFnfInput, PatchFnfInput } from "./dto/payroll.schemas";

type FnfRow = typeof fnfSettlements.$inferSelect;

export type CreateFnfResult = { ok: false } | { ok: true; record: FnfRow };
export type UpdateFnfResult = { ok: false } | { ok: true; record: FnfRow };

@Injectable()
export class FnfService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listFnf(orgId: string, userId: string, isAdmin: boolean) {
    return this.db.query.fnfSettlements.findMany({
      where: isAdmin
        ? eq(fnfSettlements.orgId, orgId)
        : and(eq(fnfSettlements.orgId, orgId), eq(fnfSettlements.userId, userId)),
      orderBy: [desc(fnfSettlements.createdAt)],
      with: { user: { columns: { name: true, email: true } } },
      limit: 100,
    });
  }

  async createFnf(orgId: string, body: CreateFnfInput): Promise<CreateFnfResult> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.userId, body.userId), eq(organizationMembers.orgId, orgId)),
      columns: { userId: true },
    });
    if (!member) return { ok: false };

    const basicDues = body.basicDues ?? 0;
    const leaveEncashment = body.leaveEncashment ?? 0;
    const bonusDue = body.bonusDue ?? 0;
    const deductions = body.deductions ?? 0;
    const loanRecovery = body.loanRecovery ?? 0;
    const netPayable = basicDues + leaveEncashment + bonusDue - deductions - loanRecovery;

    const [record] = await this.db
      .insert(fnfSettlements)
      .values({
        orgId,
        userId: body.userId,
        resignationId: body.resignationId ?? null,
        basicDues: basicDues.toString(),
        leaveEncashment: leaveEncashment.toString(),
        bonusDue: bonusDue.toString(),
        deductions: deductions.toString(),
        loanRecovery: loanRecovery.toString(),
        netPayable: netPayable.toString(),
        notes: body.notes ?? null,
        status: "DRAFT",
      })
      .returning();

    return { ok: true, record };
  }

  async updateFnf(orgId: string, userId: string, fnfId: number, body: PatchFnfInput): Promise<UpdateFnfResult> {
    const [existing] = await this.db
      .select()
      .from(fnfSettlements)
      .where(and(eq(fnfSettlements.id, fnfId), eq(fnfSettlements.orgId, orgId)));

    if (!existing) return { ok: false };

    const [updated] = await this.db
      .update(fnfSettlements)
      .set({
        status: body.status,
        approvedBy: userId,
        notes: body.notes ?? existing.notes,
        updatedAt: new Date(),
      })
      .where(eq(fnfSettlements.id, fnfId))
      .returning();

    return { ok: true, record: updated };
  }
}
