import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, itemsPagedSchema } from "../../../../common/openapi/response-envelopes";
import { fnfRowSchema } from "../../hr-payroll/dto/hr-payroll-response.schemas";

export const calendarEventRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  month: z.string().nullable(),
  type: z.string(),
  date: z.string(),
  title: z.string(),
  status: z.string(),
});

export const generateCalendarResponseSchema = z.object({
  generated: z.number().int(),
  month: z.string(),
});

export const accountingMappingRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  componentId: z.number().int().nullable(),
  category: z.string().nullable(),
  ledgerName: z.string(),
  costCenterSource: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const taxWindowRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  financialYear: z.string(),
  opensAt: wireDate(),
  closesAt: wireDate(),
  proofDeadline: nullableWireDate(),
  lockDate: z.string().nullable(),
  status: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const taxDeclarationListItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  financialYear: z.string(),
  regime: z.string(),
  hra: z.string(),
  lta: z.string(),
  section80c: z.string(),
  section80d: z.string(),
  section80g: z.string(),
  homeLoanInterest: z.string(),
  previousEmploymentIncome: z.string(),
  previousEmployerTds: z.string(),
  status: z.string(),
  verifiedBy: z.string().nullable(),
  verifiedAt: nullableWireDate(),
  reviewNote: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
});

export const taxDeclarationListSchema = cursorPageSchema(taxDeclarationListItemSchema);

export const taxDeclarationRowSchema = taxDeclarationListItemSchema.omit({ userName: true, userEmail: true });

export const fnfGetOneSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  basicDues: z.string(),
  leaveEncashment: z.string(),
  gratuity: z.string(),
  bonusDue: z.string(),
  deductions: z.string(),
  loanRecovery: z.string(),
  netPayable: z.string(),
  status: z.string(),
  approvedBy: z.string().nullable(),
  notes: z.string().nullable(),
  reimbursementsDue: z.string(),
  assetRecovery: z.string(),
  noticeRecovery: z.string(),
  otherDeductions: z.string(),
  statementPublishedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
});

export const fnfStatementSchema = z.object({
  settlementId: z.number().int(),
  employee: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
  }),
  components: z.array(
    z.object({
      label: z.string(),
      amount: z.string(),
      type: z.literal("deduction").optional(),
    }),
  ),
  netPayable: z.string(),
  status: z.string(),
});

const fnfInsightsListItemSchema = fnfRowSchema.extend({
  user: z.object({ name: z.string().nullable(), email: z.string() }).nullable().optional(),
});

export const fnfInsightsListSchema = itemsPagedSchema(fnfInsightsListItemSchema);

export { fnfRowSchema };

export const updateFnfResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(false) }),
  z.object({ ok: z.literal(true), record: fnfRowSchema }),
]);
