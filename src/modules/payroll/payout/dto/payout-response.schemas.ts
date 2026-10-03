import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, idCursorPageSchema, successSchema } from "../../../../common/openapi/response-envelopes";

export const approvalStageSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  runId: z.number().int(),
  stage: z.number().int(),
  stageName: z.string(),
  requiredPermission: z.string(),
  status: z.string(),
  actedByMembershipId: z.number().int().nullable(),
  actedAt: nullableWireDate(),
  comment: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  isCurrentUserApprover: z.boolean(),
  approverName: z.string(),
});

export const approvalListSchema = z.array(approvalStageSchema);

export const submitApprovalResponseSchema = z.object({
  autoApproved: z.boolean(),
  runStatus: z.string(),
  stagesCreated: z.number().int().optional(),
  correlationId: z.string(),
});

export const approvalActionResponseSchema = z.object({
  success: z.boolean(),
  runStatus: z.string(),
  correlationId: z.string(),
});

export const lockResponseSchema = z.object({
  success: z.boolean(),
  lockedAt: wireDate(),
  correlationId: z.string(),
});

export const reopenResponseSchema = z.object({
  success: z.boolean(),
  reopenedAt: wireDate(),
  correlationId: z.string(),
});

export const closeResponseSchema = z.object({
  success: z.boolean(),
  closedAt: wireDate(),
  correlationId: z.string(),
});

export const validationItemSchema = z.object({
  subjectKey: z.string(),
  userId: z.string().nullable(),
  workerId: z.string().nullable(),
  employeeName: z.string(),
  netAmount: z.string(),
  currency: z.string(),
  maskedAccount: z.string().nullable(),
  scheme: z.string(),
  schemeLabel: z.string(),
  errors: z.array(z.string()),
});

export const payoutValidationResponseSchema = z.array(validationItemSchema);

const batchRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  runId: z.number().int(),
  batchNumber: z.string(),
  status: z.string(),
  format: z.string(),
  totalAmount: z.string(),
  itemCount: z.number().int(),
  generatedBy: z.string().nullable(),
  generatedAt: nullableWireDate(),
  sentAt: nullableWireDate(),
  idempotencyKey: z.string().nullable(),
});

export const batchListSchema = cursorPageSchema(batchRowSchema);

const batchItemRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  batchId: z.number().int(),
  userId: z.string().nullable(),
  workerId: z.string().nullable(),
  runEmployeeId: z.number().int(),
  amount: z.string(),
  accountMasked: z.string(),
  ifsc: z.string().nullable(),
  status: z.string(),
  transactionRef: z.string().nullable(),
  failureReason: z.string().nullable(),
  paidAt: nullableWireDate(),
});

export const batchDetailSchema = z.object({
  batch: batchRowSchema,
  items: idCursorPageSchema(batchItemRowSchema),
});

const batchFullRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  runId: z.number().int(),
  batchNumber: z.string(),
  status: z.string(),
  format: z.string(),
  totalAmount: z.string(),
  itemCount: z.number().int(),
  generatedBy: z.string().nullable(),
  generatedAt: nullableWireDate(),
  sentAt: nullableWireDate(),
  idempotencyKey: z.string().nullable(),
  fileKey: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const batchItemFullRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  batchId: z.number().int(),
  runEmployeeId: z.number().int(),
  userId: z.string().nullable(),
  workerId: z.string().nullable(),
  amount: z.string(),
  accountMasked: z.string(),
  ifsc: z.string().nullable(),
  status: z.string(),
  failureReason: z.string().nullable(),
  transactionRef: z.string().nullable(),
  paidAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const createBatchResponseSchema = z.object({
  batches: z.array(
    z.object({
      batch: batchFullRowSchema,
      items: z.array(batchItemFullRowSchema),
      fileUrl: z.string().nullable(),
      currencyCode: z.string(),
      replayed: z.boolean(),
    }),
  ),
  replayed: z.boolean(),
  multiCurrency: z.object({
    currencyCount: z.number().int(),
    currencies: z.array(z.string()),
    batchCount: z.number().int(),
    honestyNote: z.string(),
  }),
});

export const bankDetailsResponseSchema = z.object({
  userId: z.string(),
  employeeName: z.string().nullable(),
  accountNumber: z.string().nullable(),
  bankName: z.string().nullable(),
  branch: z.string().nullable(),
  ifsc: z.string().nullable(),
  accountHolder: z.string().nullable(),
  pfUanNumber: z.string().nullable(),
  bankCountry: z.string().nullable(),
});

export const importBankReturnResponseSchema = z.object({
  success: z.boolean(),
  paid: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  parseErrors: z.array(z.string()),
  honestyNote: z.string().optional(),
  mode: z.literal("export_manual"),
});

export const payslipTemplateRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  layout: z.string(),
  config: z.record(z.string(), z.unknown()),
  isDefault: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const payslipTemplateListSchema = cursorPageSchema(payslipTemplateRowSchema);

export const previewTemplateResponseSchema = z.object({
  html: z.string(),
});

const publicationItemSchema = z.object({
  id: z.number().int(),
  userId: z.string().nullable(),
  workerId: z.string().nullable(),
  runEmployeeId: z.number().int(),
  status: z.string(),
  channel: z.string().nullable().optional(),
  pdfUrl: z.string().nullable(),
  publishedAt: nullableWireDate(),
  snapshotHash: z.string().nullable().optional(),
  failureReason: z.string().nullable(),
  attemptCount: z.number().int().optional(),
  lastAttemptAt: nullableWireDate().optional(),
});

export const publicationListSchema = z.object({
  items: z.array(publicationItemSchema),
  truncated: z.boolean(),
});

export const publishResponseSchema = z.object({
  published: z.number().int(),
  total: z.number().int(),
  heldCount: z.number().int(),
  runStatus: z.string().nullable(),
});

export const retryPublishResponseSchema = z.object({
  published: z.number().int(),
  total: z.number().int(),
  heldCount: z.number().int(),
  runStatus: z.string().nullable(),
  retried: z.number().int(),
});

export const retryOnePublishResponseSchema = retryPublishResponseSchema.extend({
  publicationId: z.number().int(),
});

export { successSchema };
