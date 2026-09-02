import { z } from "zod";

export const FINANCE_REPORT_EXPORT_AGGREGATE_TYPE = "finance_report_export_job";
export const FINANCE_REPORT_EXPORT_REQUESTED_EVENT = "finance.report.export.requested";

const FINANCE_REPORT_TYPES = [
  "vendor_statement",
  "customer_statement",
  "sales_by_customer",
  "sales_by_item",
  "expense_by_category",
  "tax_summary",
  "project_profitability",
  "department_profitability",
  "budget_vs_actual",
] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

export const createFinanceReportExportJobSchema = z
  .object({
    reportType: z.enum(FINANCE_REPORT_TYPES),
    from: isoDate,
    to: isoDate,
    vendorId: z.number().int().positive().optional(),
    clientId: z.number().int().positive().optional(),
    budgetId: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (v) => {
      if (v.reportType === "vendor_statement") return v.vendorId !== undefined;
      if (v.reportType === "customer_statement") return v.clientId !== undefined;
      if (v.reportType === "budget_vs_actual") return v.budgetId !== undefined;
      return true;
    },
    { message: "Required parameter missing for report type" },
  );

export type CreateFinanceReportExportJobInput = z.infer<typeof createFinanceReportExportJobSchema>;

export const finReportExportJobIdParams = z.object({ jobId: z.string().min(1) }).strict();

export const financeReportExportRequestedPayloadSchema = z.object({
  jobId: z.string().uuid(),
  orgId: z.string().min(1),
});

type FinanceReportExportRequestedPayload = z.infer<typeof financeReportExportRequestedPayloadSchema>;
