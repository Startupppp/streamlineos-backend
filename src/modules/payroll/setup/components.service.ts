import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { SQL, and, count, eq, getTableColumns, ilike, or } from "drizzle-orm";
import { salaryComponents, employeeSalaryProfileComponents } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { validateFormula } from "./lib/template-preview";
import type { ListComponentsInput, CreateComponentInput, UpdateComponentInput } from "./dto/setup.schemas";
import { resolveWindowedTotal, totalOverWindow, withoutTotal } from "../../../common/pagination/window-count";

type ComponentRow = typeof salaryComponents.$inferSelect;

@Injectable()
export class PayrollComponentsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, input: ListComponentsInput): Promise<{ items: ComponentRow[]; total: number }> {
    const filters: SQL[] = [eq(salaryComponents.orgId, orgId)];

    if (input.type) {
      filters.push(eq(salaryComponents.type, input.type as ComponentRow["type"]));
    }
    if (input.active !== undefined) {
      filters.push(eq(salaryComponents.isActive, input.active));
    }
    if (input.search) {
      filters.push(
        or(
          ilike(salaryComponents.name, `%${input.search}%`),
          ilike(salaryComponents.code, `%${input.search}%`),
        ) as SQL,
      );
    }

    const where = and(...filters);
    const offset = (input.page - 1) * input.pageSize;

    const rows = await this.db
      .select({ ...getTableColumns(salaryComponents), total: totalOverWindow })
      .from(salaryComponents)
      .where(where)
      .orderBy(salaryComponents.sortOrder, salaryComponents.name)
      .limit(input.pageSize)
      .offset(offset);

    const total = await resolveWindowedTotal(rows, offset, async () => {
      const [totalRow] = await this.db
        .select({ total: count() })
        .from(salaryComponents)
        .where(where);
      return Number(totalRow?.total ?? 0);
    });

    return { items: withoutTotal(rows), total };
  }

  async create(u: CurrentUserContext, input: CreateComponentInput): Promise<ComponentRow> {
    this.validateComponentInput(input);

    const existing = await this.db.query.salaryComponents.findFirst({
      where: and(eq(salaryComponents.orgId, u.orgId), eq(salaryComponents.code, input.code)),
      columns: { id: true },
    });
    if (existing) throw new ConflictException(`A component with code "${input.code}" already exists`);

    const [created] = await this.db
      .insert(salaryComponents)
      .values({
        orgId: u.orgId,
        code: input.code,
        name: input.name,
        type: input.type,
        calcMethod: input.calcMethod,
        amount: input.amount ?? null,
        percent: input.percent ?? null,
        formula: input.formula ?? null,
        taxable: input.taxable,
        showOnPayslip: input.showOnPayslip,
        includeInCtc: input.includeInCtc,
        isStatutory: input.isStatutory,
        statutoryKey: input.statutoryKey ?? null,
        sortOrder: input.sortOrder,
        isActive: true,
      })
      .returning();
    return created;
  }

  async update(u: CurrentUserContext, componentId: number, input: UpdateComponentInput): Promise<ComponentRow> {
    const component = await this.assertBelongsToOrg(u.orgId, componentId);

    if (input.formula !== undefined) {
      this.validateFormulaString(input.formula);
    }

    const values: Partial<typeof salaryComponents.$inferInsert> = {};
    if (input.name !== undefined) values.name = input.name;
    if (input.type !== undefined) values.type = input.type;
    if (input.calcMethod !== undefined) values.calcMethod = input.calcMethod;
    if (input.amount !== undefined) values.amount = input.amount ?? null;
    if (input.percent !== undefined) values.percent = input.percent ?? null;
    if (input.formula !== undefined) values.formula = input.formula ?? null;
    if (input.taxable !== undefined) values.taxable = input.taxable;
    if (input.showOnPayslip !== undefined) values.showOnPayslip = input.showOnPayslip;
    if (input.includeInCtc !== undefined) values.includeInCtc = input.includeInCtc;
    if (input.isStatutory !== undefined) values.isStatutory = input.isStatutory;
    if (input.statutoryKey !== undefined) values.statutoryKey = input.statutoryKey ?? null;
    if (input.sortOrder !== undefined) values.sortOrder = input.sortOrder;

    if (Object.keys(values).length === 0) return component;

    const [updated] = await this.db
      .update(salaryComponents)
      .set(values)
      .where(and(eq(salaryComponents.id, componentId), eq(salaryComponents.orgId, u.orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Component not found");
    return updated;
  }

  async remove(u: CurrentUserContext, componentId: number): Promise<{ success: boolean; softDeleted: boolean }> {
    await this.assertBelongsToOrg(u.orgId, componentId);

    const [usageRow] = await this.db
      .select({ total: count() })
      .from(employeeSalaryProfileComponents)
      .where(
        and(
          eq(employeeSalaryProfileComponents.componentId, componentId),
          eq(employeeSalaryProfileComponents.orgId, u.orgId),
        ),
      );

    if ((usageRow?.total ?? 0) > 0) {
      await this.db
        .update(salaryComponents)
        .set({ isActive: false })
        .where(and(eq(salaryComponents.id, componentId), eq(salaryComponents.orgId, u.orgId)));
      return { success: true, softDeleted: true };
    }

    await this.db
      .delete(salaryComponents)
      .where(and(eq(salaryComponents.id, componentId), eq(salaryComponents.orgId, u.orgId)));
    return { success: true, softDeleted: false };
  }

  private validateComponentInput(input: Pick<CreateComponentInput, "calcMethod" | "formula" | "amount" | "percent">) {
    if (input.calcMethod === "FORMULA" && input.formula) {
      this.validateFormulaString(input.formula);
    }
    if (input.calcMethod === "FIXED" && !input.amount) {
      throw new BadRequestException("amount is required for FIXED calc method");
    }
    if ((input.calcMethod === "PERCENT_OF_BASIC" || input.calcMethod === "PERCENT_OF_GROSS") && !input.percent) {
      throw new BadRequestException("percent is required for PERCENT_OF_BASIC / PERCENT_OF_GROSS calc methods");
    }
  }

  private validateFormulaString(formula: string) {
    const result = validateFormula(formula);
    if (!result.valid) {
      throw new BadRequestException(
        `Formula contains unknown identifiers: ${result.unknownIdentifiers.join(", ")}. Allowed: ${["basic", "gross", "ctc", "days_in_month", "paid_days", "lop_days", "overtime_hours", "incentive_amount", "reimbursement_amount"].join(", ")}`,
      );
    }
  }

  private async assertBelongsToOrg(orgId: string, componentId: number): Promise<ComponentRow> {
    const component = await this.db.query.salaryComponents.findFirst({
      where: and(eq(salaryComponents.id, componentId), eq(salaryComponents.orgId, orgId)),
    });
    if (!component) throw new NotFoundException("Component not found");
    return component;
  }
}
