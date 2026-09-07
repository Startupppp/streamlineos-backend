import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { salaryStructureTemplates } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { buildCursorPage } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import {
  decodePayrollTimestampCursor,
  payrollCursorPosition,
} from "../payroll-cursor";

@Injectable()
export class SalaryStructureTemplatesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, cursor?: string, limit = 50) {
    const cap = Math.min(limit, 100);
    const cursorScope = ["salary-structure-templates", orgId] as const;
    const position = decodePayrollTimestampCursor(cursor, cursorScope);
    const conditions = [eq(salaryStructureTemplates.orgId, orgId)];
    if (position) {
      conditions.push(
        keysetBeforeId(
          salaryStructureTemplates.createdAt,
          salaryStructureTemplates.id,
          { sortValue: position.createdAt, id: String(position.id) },
        ),
      );
    }
    const rows = await this.db
      .select({
        id: salaryStructureTemplates.id,
        orgId: salaryStructureTemplates.orgId,
        name: salaryStructureTemplates.name,
        basicSalary: salaryStructureTemplates.basicSalary,
        hraPercent: salaryStructureTemplates.hraPercent,
        specialAllowance: salaryStructureTemplates.specialAllowance,
        medicalAllowance: salaryStructureTemplates.medicalAllowance,
        travelAllowance: salaryStructureTemplates.travelAllowance,
        otherAllowances: salaryStructureTemplates.otherAllowances,
        pfDeductionPercent: salaryStructureTemplates.pfDeductionPercent,
        professionalTax: salaryStructureTemplates.professionalTax,
        effectiveFrom: salaryStructureTemplates.effectiveFrom,
        effectiveTo: salaryStructureTemplates.effectiveTo,
        isActive: salaryStructureTemplates.isActive,
        createdAt: salaryStructureTemplates.createdAt,
        updatedAt: salaryStructureTemplates.updatedAt,
      })
      .from(salaryStructureTemplates)
      .where(and(...conditions))
      .orderBy(desc(salaryStructureTemplates.createdAt), desc(salaryStructureTemplates.id))
      .limit(cap + 1);

    return buildCursorPage(rows, cap, (row) =>
      payrollCursorPosition(cursorScope, [row.createdAt.toISOString()], row.id),
    );
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
