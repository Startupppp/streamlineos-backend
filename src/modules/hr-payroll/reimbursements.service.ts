import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { reimbursements } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateReimbursementInput } from "./dto/payroll.schemas";

@Injectable()
export class ReimbursementsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listReimbursements(orgId: string, userId: string, isAdmin: boolean) {
    const conditions = [eq(reimbursements.orgId, orgId)];
    if (!isAdmin) conditions.push(eq(reimbursements.userId, userId));

    return this.db.query.reimbursements.findMany({
      where: and(...conditions),
      with: { user: true },
      orderBy: [desc(reimbursements.createdAt)],
    });
  }

  async createReimbursement(orgId: string, userId: string, body: CreateReimbursementInput) {
    const [record] = await this.db
      .insert(reimbursements)
      .values({
        orgId,
        userId,
        category: body.category,
        amount: body.amount.toString(),
        description: body.description,
        receiptUrl: body.receiptUrl || undefined,
        status: "PENDING",
      })
      .returning();
    return record;
  }
}
