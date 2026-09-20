import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { taxDeclarationListItemSchema } from "./insights-response.schemas";

const relatedUserSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string(),
    image: z.string().nullable(),
  })
  .nullable();

export const reimbursementRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  category: z.string(),
  amount: z.string(),
  description: z.string().nullable(),
  receiptUrl: z.string().nullable(),
  status: z.string(),
  userMembershipId: z.number().int().nullable(),
  payrollMonth: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedByMembershipId: z.number().int().nullable(),
  approvedAt: nullableWireDate(),
  paidAt: nullableWireDate(),
  rejectionReason: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const reimbursementRowWithUserSchema = reimbursementRowSchema.extend({
  user: relatedUserSchema,
});

export const essReimbursementsListSchema = z.object({
  items: z.array(reimbursementRowWithUserSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
});

export const loanRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  amount: z.string(),
  reason: z.string().nullable(),
  emiAmount: z.string().nullable(),
  totalEmis: z.number().int().nullable(),
  paidEmis: z.number().int(),
  status: z.string(),
  userMembershipId: z.number().int().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: nullableWireDate(),
  disbursedAt: nullableWireDate(),
  closedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const loanRowWithBalanceSchema = loanRowSchema.extend({
  balance: z.string(),
});

export const loanRowWithUserAndBalanceSchema = loanRowWithBalanceSchema.extend({
  user: relatedUserSchema,
});

export const essLoansListSchema = z.array(loanRowWithUserAndBalanceSchema);

export const taxDeclarationRowSchema = taxDeclarationListItemSchema.omit({
  userName: true,
  userEmail: true,
});

export const investmentProofRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  declarationId: z.number().int(),
  category: z.string(),
  amount: z.string(),
  description: z.string().nullable(),
  proofUrl: z.string().nullable(),
  status: z.string(),
  createdAt: wireDate(),
});

export const taxDeclarationResponseSchema = z.union([
  z.object({
    windowStatus: z.null(),
    declaration: z.null(),
    proofs: z.array(investmentProofRowSchema),
  }),
  z.object({
    windowStatus: z.literal("OPEN"),
    financialYear: z.string(),
    closesAt: wireDate(),
    declaration: taxDeclarationRowSchema.nullable(),
    proofs: z.array(investmentProofRowSchema),
  }),
]);

const bankMaskedSchema = z.object({
  accountNumber: z.string(),
  bankName: z.string(),
  branch: z.string(),
  ifsc: z.string(),
  accountHolder: z.string(),
  bankCountry: z.string().nullable(),
});

export const bankDetailsResponseSchema = z.union([
  z.object({ hasBank: z.literal(false), masked: z.null() }),
  z.object({ hasBank: z.literal(true), masked: bankMaskedSchema }),
]);

export const updateBankResultSchema = z.object({ updated: z.literal(true) });

export const ownFnfSchema = z
  .object({
    id: z.number().int(),
    basicDues: z.string(),
    leaveEncashment: z.string(),
    bonusDue: z.string(),
    deductions: z.string(),
    loanRecovery: z.string(),
    netPayable: z.string(),
    status: z.string(),
    notes: z.string().nullable(),
    reimbursementsDue: z.string(),
    assetRecovery: z.string(),
    noticeRecovery: z.string(),
    otherDeductions: z.string(),
    statementPublishedAt: nullableWireDate(),
    createdAt: wireDate(),
  })
  .nullable();

export const essPayslipItemSchema = z.object({
  publicationId: z.number().int(),
  month: z.string(),
  net: z.string().nullable(),
  publishedAt: wireDate(),
  downloadHref: z.string(),
});

export const essPayslipsListSchema = z.array(essPayslipItemSchema);

const essSalaryComponentSchema = z.object({
  code: z.string(),
  name: z.string(),
  type: z.string(),
  amount: z.string().nullable(),
  percent: z.string().nullable(),
});

export const essSalaryStructureSchema = z.union([
  z.object({
    profile: z.object({
      annualCtc: z.string().nullable(),
      workerType: z.string(),
      taxRegime: z.string().nullable(),
      costCenter: z.string().nullable(),
      effectiveFrom: z.string(),
    }),
    components: z.array(essSalaryComponentSchema),
    setupRequired: z.literal(false),
  }),
  z.object({
    profile: z.null(),
    components: z.array(essSalaryComponentSchema),
    setupRequired: z.literal(true),
    message: z.string(),
  }),
]);

const essActionItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  severity: z.enum(["info", "warning"]),
  href: z.string(),
});

export const essOverviewSchema = z.object({
  toggles: z.record(z.string(), z.boolean()),
  capabilities: z.object({
    mode: z.literal("employee_self_service"),
    honestyNote: z.string(),
    canViewSalaryStructure: z.boolean(),
    canUpdateBank: z.boolean(),
    canRequestLoans: z.boolean(),
    canDeclareTax: z.boolean(),
    canClaimReimbursements: z.boolean(),
  }),
  latestPayslip: z
    .object({
      publicationId: z.number().int(),
      month: z.string(),
      net: z.string().nullable(),
      downloadHref: z.string(),
    })
    .nullable(),
  nextPayDate: z.object({ date: z.string(), label: z.string() }).nullable(),
  ytd: z.object({ gross: z.string(), net: z.string() }),
  activeLoanBalance: z.string(),
  pendingReimbursementsCount: z.number().int(),
  taxWindow: z
    .object({
      status: z.string(),
      financialYear: z.string(),
      closesAt: wireDate(),
    })
    .nullable(),
  declarationStatus: z.string().nullable(),
  actionRequired: z.array(essActionItemSchema),
});

const totalRewardsBenefitLineSchema = z.object({
  planName: z.string(),
  category: z.string(),
  status: z.string(),
  estimatedEmployerMonthly: z.string().nullable(),
  note: z.string(),
});

const totalRewardsEquityLineSchema = z.object({
  grantType: z.string(),
  units: z.number(),
  status: z.string(),
  grantDate: z.string(),
  strikePrice: z.string().nullable(),
  note: z.string(),
});

export const totalRewardsStatementSchema = z.object({
  mode: z.literal("illustrative_statement"),
  honestyNote: z.string(),
  asOf: z.string(),
  financialYear: z.string(),
  cash: z.object({
    annualCtc: z.string().nullable(),
    ytdGross: z.string(),
    ytdNet: z.string(),
    activeLoanBalance: z.string(),
  }),
  benefits: z.object({
    lines: z.array(totalRewardsBenefitLineSchema),
    estimatedEmployerAnnual: z.string().nullable(),
  }),
  equity: z.object({
    lines: z.array(totalRewardsEquityLineSchema),
    totalUnits: z.number(),
    valued: z.literal(false),
  }),
  leave: z.object({
    lines: z.array(z.object({ leaveType: z.string(), balanceDays: z.string() })),
    note: z.string(),
  }),
  summary: z.object({
    cashAnnualCtc: z.string().nullable(),
    benefitsEmployerAnnualEstimate: z.string().nullable(),
    equityUnits: z.number(),
    completeness: z.enum(["partial", "rich"]),
    missing: z.array(z.string()),
  }),
});
