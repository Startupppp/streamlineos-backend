import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gt, ne } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payslipTemplates } from "../../../db/schema";
import { renderPayslipHtml } from "./lib/payslip-renderer";
import type { CreateTemplateInput, PatchTemplateInput, PayslipTemplateConfig, PreviewTemplateInput } from "./dto/payout.schemas";
import type { CalculationSnapshot } from "../payroll.types";
import { buildCursorPage } from "../../../common/pagination/cursor";
import {
  decodePayrollIdCursor,
  payrollCursorPosition,
} from "../payroll-cursor";

@Injectable()
export class PayslipTemplatesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string, cursor?: string, limit = 50) {
    const cap = Math.min(limit, 100);
    const cursorScope = ["payslip-templates", orgId] as const;
    const position = decodePayrollIdCursor(cursor, cursorScope);

    const existing = await this.db
      .select({ id: payslipTemplates.id })
      .from(payslipTemplates)
      .where(eq(payslipTemplates.orgId, orgId))
      .limit(1);

    if (existing.length === 0) {
      const defaults = [
        {
          orgId,
          name: "Classic Table",
          layout: "CLASSIC" as const,
          config: { accent: "#0f2b7f", showEmployerContributions: false, showYtd: false },
          isDefault: true,
        },
        {
          orgId,
          name: "Modern Compact",
          layout: "MODERN" as const,
          config: { accent: "#3b82f6", showEmployerContributions: false, showYtd: false },
          isDefault: false,
        },
        {
          orgId,
          name: "Detailed Compliance",
          layout: "COMPLIANCE" as const,
          config: { accent: "#1e293b", showEmployerContributions: true, showYtd: false },
          isDefault: false,
        },
      ];
      const seeded = await this.db.insert(payslipTemplates).values(defaults).returning();
      seeded.sort((left, right) => left.id - right.id);
      return buildCursorPage(seeded, cap, (row) =>
        payrollCursorPosition(cursorScope, [row.id], row.id),
      );
    }

    const conditions = [eq(payslipTemplates.orgId, orgId)];
    if (position) conditions.push(gt(payslipTemplates.id, position.id));
    const rows = await this.db
      .select()
      .from(payslipTemplates)
      .where(and(...conditions))
      .orderBy(asc(payslipTemplates.id))
      .limit(cap + 1);

    return buildCursorPage(rows, cap, (row) =>
      payrollCursorPosition(cursorScope, [row.id], row.id),
    );
  }

  async create(orgId: string, data: CreateTemplateInput) {
    return this.db.transaction(async (tx) => {
      if (data.isDefault) {
        await tx
          .update(payslipTemplates)
          .set({ isDefault: false })
          .where(eq(payslipTemplates.orgId, orgId));
      }
      const [inserted] = await tx
        .insert(payslipTemplates)
        .values({ orgId, name: data.name, layout: data.layout, config: data.config, isDefault: data.isDefault })
        .returning();
      return inserted;
    });
  }

  async update(orgId: string, templateId: number, data: PatchTemplateInput) {
    const [template] = await this.db
      .select()
      .from(payslipTemplates)
      .where(and(eq(payslipTemplates.id, templateId), eq(payslipTemplates.orgId, orgId)))
      .limit(1);

    if (!template) throw new NotFoundException("Template not found");

    const rawConfig = template.config;
    const existingConfig: PayslipTemplateConfig = rawConfig && typeof rawConfig === "object"
      ? { accent: "#0f2b7f", showEmployerContributions: false, showYtd: false, ...(rawConfig as Partial<PayslipTemplateConfig>) }
      : { accent: "#0f2b7f", showEmployerContributions: false, showYtd: false };
    const mergedConfig: PayslipTemplateConfig | undefined =
      data.config !== undefined ? { ...existingConfig, ...data.config } : undefined;

    return this.db.transaction(async (tx) => {
      if (data.isDefault === true) {
        await tx
          .update(payslipTemplates)
          .set({ isDefault: false })
          .where(and(eq(payslipTemplates.orgId, orgId), ne(payslipTemplates.id, templateId)));
      }
      const [updated] = await tx
        .update(payslipTemplates)
        .set({
          ...(data.name !== undefined && { name: data.name }),
          ...(data.layout !== undefined && { layout: data.layout }),
          ...(mergedConfig !== undefined && { config: mergedConfig }),
          ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
        })
        .where(and(eq(payslipTemplates.id, templateId), eq(payslipTemplates.orgId, orgId)))
        .returning();
      return updated;
    });
  }

  async delete(orgId: string, templateId: number) {
    const [template] = await this.db
      .select()
      .from(payslipTemplates)
      .where(and(eq(payslipTemplates.id, templateId), eq(payslipTemplates.orgId, orgId)))
      .limit(1);

    if (!template) throw new NotFoundException("Template not found");

    if (template.isDefault) {
      throw new ConflictException("Cannot delete the default template — set another as default first");
    }

    await this.db
      .delete(payslipTemplates)
      .where(and(eq(payslipTemplates.id, templateId), eq(payslipTemplates.orgId, orgId)));

    return { success: true };
  }

  preview(data: PreviewTemplateInput): string {
    const fakeSnapshot: CalculationSnapshot = {
      policyVersionId: null,
      computedAt: new Date().toISOString(),
      currency: "INR",
      scheduledDays: "26",
      paidDays: "26",
      lopDays: "0",
      overtimeHours: "0",
      lines: [
        {
          code: "BASIC",
          name: "Basic Salary",
          category: "EARNING",
          amount: "30000.00",
          calcMethod: "FIXED",
          taxable: true,
          sortOrder: 1,
          explain: { method: "FIXED", inputs: {}, steps: ["Fixed amount: 30000.00"] },
        },
        {
          code: "HRA",
          name: "House Rent Allowance",
          category: "EARNING",
          amount: "12000.00",
          calcMethod: "PERCENT_OF_BASIC",
          taxable: false,
          sortOrder: 2,
          explain: { method: "PERCENT_OF_BASIC", inputs: { basic: 30000 }, steps: ["40% of basic 30000 = 12000.00"] },
        },
        {
          code: "SA",
          name: "Special Allowance",
          category: "EARNING",
          amount: "8000.00",
          calcMethod: "FIXED",
          taxable: true,
          sortOrder: 3,
          explain: { method: "FIXED", inputs: {}, steps: ["Fixed amount: 8000.00"] },
        },
        {
          code: "PF_EE",
          name: "Provident Fund",
          category: "DEDUCTION",
          amount: "1800.00",
          calcMethod: "FIXED",
          taxable: false,
          sortOrder: 10,
          explain: { method: "FIXED", inputs: {}, steps: ["Fixed amount: 1800.00"] },
        },
        {
          code: "PT",
          name: "Professional Tax",
          category: "DEDUCTION",
          amount: "200.00",
          calcMethod: "FIXED",
          taxable: false,
          sortOrder: 11,
          explain: { method: "FIXED", inputs: {}, steps: ["Fixed amount: 200.00"] },
        },
        {
          code: "PF_ER",
          name: "PF Employer Contribution",
          category: "EMPLOYER_CONTRIBUTION",
          amount: "1800.00",
          calcMethod: "FIXED",
          taxable: false,
          sortOrder: 20,
          explain: { method: "FIXED", inputs: {}, steps: ["Fixed amount: 1800.00"] },
        },
      ],
      totals: {
        gross: "50000.00",
        deductions: "2000.00",
        employerContributions: "1800.00",
        net: "48000.00",
      },
      variance: null,
    };

    return renderPayslipHtml({
      snapshot: fakeSnapshot,
      employee: {
        name: "Riya Sharma",
        employeeId: "EMP-001",
        designation: "Senior Engineer",
        department: "Engineering",
        joiningDate: "01 Apr 2022",
        maskedAccount: "XXXX1234",
        bankName: "HDFC Bank",
        ifsc: "HDFC0001234",
        pan: "ABCDE1234F",
      },
      org: { name: "Your Organization", address: "" },
      workerType: "EMPLOYEE",
      month: new Date().toISOString().slice(0, 7),
      layout: data.layout,
      config: data.config,
    });
  }
}
