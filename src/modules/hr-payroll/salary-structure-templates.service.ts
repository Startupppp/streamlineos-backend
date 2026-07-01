import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { salaryStructureTemplates } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

@Injectable()
export class SalaryStructureTemplatesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string) {
    return this.db
      .select()
      .from(salaryStructureTemplates)
      .where(eq(salaryStructureTemplates.orgId, orgId))
      .orderBy(desc(salaryStructureTemplates.createdAt))
      .limit(100);
  }

  async create(
    orgId: string,
    data: Omit<typeof salaryStructureTemplates.$inferInsert, "id" | "orgId" | "createdAt" | "updatedAt">,
  ) {
    const [item] = await this.db
      .insert(salaryStructureTemplates)
      .values({ ...data, orgId })
      .returning();
    return item;
  }

  async update(
    orgId: string,
    id: number,
    data: Partial<Omit<typeof salaryStructureTemplates.$inferInsert, "id" | "orgId" | "createdAt" | "updatedAt">>,
  ) {
    const [item] = await this.db
      .update(salaryStructureTemplates)
      .set(data)
      .where(and(eq(salaryStructureTemplates.id, id), eq(salaryStructureTemplates.orgId, orgId)))
      .returning();
    if (!item) throw new NotFoundException("Salary structure template not found");
    return item;
  }

  async remove(orgId: string, id: number) {
    const [item] = await this.db
      .update(salaryStructureTemplates)
      .set({ isActive: false })
      .where(and(eq(salaryStructureTemplates.id, id), eq(salaryStructureTemplates.orgId, orgId)))
      .returning();
    if (!item) throw new NotFoundException("Salary structure template not found");
  }
}
