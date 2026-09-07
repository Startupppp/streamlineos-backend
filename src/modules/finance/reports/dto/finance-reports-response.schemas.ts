import { z } from "zod";

const profitabilityRowSchema = z.object({
  revenue: z.string(),
  cost: z.string(),
  margin: z.string(),
  marginPct: z.string(),
});

export const projectProfitabilityResponseSchema = z.array(
  profitabilityRowSchema.extend({
    projectId: z.number().int(),
    projectName: z.string(),
  }),
);

export const departmentProfitabilityResponseSchema = z.array(
  profitabilityRowSchema.extend({
    departmentId: z.number().int().nullable(),
    departmentName: z.string(),
  }),
);

const budgetLineSchema = z.object({
  accountId: z.number().int(),
  accountName: z.string(),
  periodKey: z.string(),
  budgetAmount: z.string(),
  actualAmount: z.string(),
  variance: z.string(),
  variancePct: z.string(),
});

export const budgetVsActualResponseSchema = z.object({
  budget: z.object({
    id: z.number().int(),
    name: z.string(),
    fiscalYear: z.string(),
  }),
  lines: z.array(budgetLineSchema),
});

export const workingCapitalResponseSchema = z.object({
  asOf: z.string(),
  currentAssets: z.string(),
  currentLiabilities: z.string(),
  workingCapital: z.string(),
  ratio: z.string().nullable(),
});

export const burnRateResponseSchema = z.object({
  months: z.array(z.object({ month: z.string(), netOutflow: z.string() })),
  averageBurnRate: z.string(),
});

export const cashRunwayResponseSchema = z.object({
  cashBalance: z.string(),
  averageBurnRate: z.string(),
  runwayMonths: z.number().int().nullable(),
  projectedMonths: z.array(z.object({ month: z.string(), projectedBalance: z.string() })),
});

const bankAccountSummarySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  balance: z.string(),
});

const countAmountSchema = z.object({ count: z.number().int(), amount: z.string() });

const drillEntrySchema = z.object({
  type: z.string(),
  params: z.record(z.string(), z.string()),
});

const monthlyTrendItemSchema = z.object({
  month: z.string(),
  revenue: z.string(),
  expenses: z.string(),
});

export const overviewResponseSchema = z.object({
  cashBalance: z.string(),
  bankAccounts: z.array(bankAccountSummarySchema),
  revenueThisMonth: z.string(),
  expensesThisMonth: z.string(),
  netProfit: z.string(),
  arOverdue: countAmountSchema,
  apDueNext7: countAmountSchema,
  taxPayable: z.string(),
  burnRate: z.string(),
  runwayMonths: z.number().int().nullable(),
  reconciliationGaps: z.number().int(),
  openApprovals: z.number().int(),
  monthlyTrend: z.array(monthlyTrendItemSchema),
  drill: z.record(z.string(), drillEntrySchema),
  period: z.object({ from: z.string(), to: z.string() }),
});

const reportCatalogItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  endpoint: z.string(),
  params: z.array(z.string()),
  category: z.string(),
  exportable: z.boolean(),
});

export const reportCatalogResponseSchema = z.array(reportCatalogItemSchema);

const statementLineSchema = z.object({
  date: z.string(),
  docType: z.string(),
  docNumber: z.string(),
  debit: z.string(),
  credit: z.string(),
  runningBalance: z.string(),
});

export const vendorStatementResponseSchema = z.object({
  vendor: z.object({ id: z.number().int(), name: z.string() }),
  openingBalance: z.string(),
  lines: z.array(statementLineSchema),
  closingBalance: z.string(),
});

export const customerStatementResponseSchema = z.object({
  client: z.object({ id: z.number().int(), name: z.string() }),
  openingBalance: z.string(),
  lines: z.array(statementLineSchema),
  closingBalance: z.string(),
});

export const salesByCustomerResponseSchema = z.array(
  z.object({
    clientId: z.number().int().nullable(),
    clientName: z.string(),
    invoiceCount: z.number().int(),
    totalBilled: z.string(),
    totalPaid: z.string(),
    outstanding: z.string(),
  }),
);

export const salesByItemResponseSchema = z.array(
  z.object({
    description: z.string().nullable(),
    totalQuantity: z.string(),
    totalAmount: z.string(),
    invoiceCount: z.number().int(),
  }),
);

export const expenseByCategoryResponseSchema = z.array(
  z.object({
    categoryId: z.number().int().nullable(),
    categoryName: z.string(),
    totalAmount: z.string(),
    count: z.number().int(),
  }),
);

export const taxSummaryResponseSchema = z.array(
  z.object({
    month: z.string(),
    outputCgst: z.string(),
    outputSgst: z.string(),
    outputIgst: z.string(),
    inputCgst: z.string(),
    inputSgst: z.string(),
    inputIgst: z.string(),
    netPayable: z.string(),
  }),
);
