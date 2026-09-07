import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const profileListItemSchema = z.object({
  id: z.number().int(),
  userId: z.string().nullable(),
  workerId: z.string().nullable(),
  workerType: z.enum(["EMPLOYEE", "CONTRACTOR", "CONSULTANT", "INTERN", "EOR"]),
  currency: z.string(),
  annualCtc: z.string(),
  taxRegime: z.enum(["OLD", "NEW"]).nullable(),
  costCenter: z.string().nullable(),
  status: z.enum(["UPCOMING", "ACTIVE", "SUPERSEDED"]),
  effectiveFrom: z.string(),
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
});

export const profileDetailSchema = z.object({
  id: z.number().int(),
  userId: z.string().nullable(),
  workerId: z.string().nullable(),
  workerType: z.enum(["EMPLOYEE", "CONTRACTOR", "CONSULTANT", "INTERN", "EOR"]),
  currency: z.string(),
  payoutCurrency: z.string().nullable(),
  annualCtc: z.string(),
  taxRegime: z.enum(["OLD", "NEW"]).nullable(),
  costCenter: z.string().nullable(),
  status: z.enum(["UPCOMING", "ACTIVE", "SUPERSEDED"]),
  effectiveFrom: z.string(),
});

const profileComponentSchema = z.object({
  id: z.number().int(),
  componentId: z.number().int(),
  calcMethodOverride: z.string().nullable(),
  amount: z.string().nullable(),
  percent: z.string().nullable(),
  formulaOverride: z.string().nullable(),
  sortOrder: z.number().int(),
  code: z.string(),
  name: z.string(),
  type: z.string(),
  calcMethod: z.string(),
  taxable: z.boolean(),
});

export const profileDetailResponseSchema = z.object({
  active: profileDetailSchema.nullable(),
  components: z.array(profileComponentSchema),
  history: z.array(profileDetailSchema),
});

export const profileListResponseSchema = cursorPageSchema(profileListItemSchema);

export const profileHistoryResponseSchema = z.array(profileDetailSchema);

export const profileCreateResponseSchema = z.object({
  profileId: z.number().int(),
});

export const payrollRunExportJobSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "expired", "cancelled"]),
  processedRows: z.number().int(),
  rowCount: z.number().int().nullable(),
  truncated: z.boolean(),
  fileName: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: wireDate(),
  completedAt: wireDate().nullable(),
  expiresAt: wireDate().nullable(),
});
