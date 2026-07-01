import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { allowanceTypes } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

@Injectable()
export class AllowancesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string) {
    return this.db
      .select()
      .from(allowanceTypes)
      .where(and(eq(allowanceTypes.orgId, orgId), eq(allowanceTypes.isActive, true)))
      .orderBy(allowanceTypes.category, desc(allowanceTypes.createdAt))
      .limit(100);
  }

  async create(orgId: string, data: Omit<typeof allowanceTypes.$inferInsert, "id" | "orgId" | "createdAt">) {
    const [item] = await this.db
      .insert(allowanceTypes)
      .values({ ...data, orgId })
      .returning();
    return item;
  }

  async update(orgId: string, id: number, data: Partial<Omit<typeof allowanceTypes.$inferInsert, "id" | "orgId" | "createdAt">>) {
    const [item] = await this.db
      .update(allowanceTypes)
      .set(data)
      .where(and(eq(allowanceTypes.id, id), eq(allowanceTypes.orgId, orgId)))
      .returning();
    if (!item) throw new NotFoundException("Allowance/deduction not found");
    return item;
  }

  async remove(orgId: string, id: number) {
    const [item] = await this.db
      .update(allowanceTypes)
      .set({ isActive: false })
      .where(and(eq(allowanceTypes.id, id), eq(allowanceTypes.orgId, orgId)))
      .returning();
    if (!item) throw new NotFoundException("Allowance/deduction not found");
  }
}
