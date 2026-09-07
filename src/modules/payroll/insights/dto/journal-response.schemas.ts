import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

const journalBatchLineSchema = z.object({
  lineNo: z.number().int(),
  account: z.string(),
  description: z.string(),
  debit: z.string(),
  credit: z.string(),
  costCenter: z.string().nullable(),
});

export const journalBatchSummarySchema = z.object({
  id: z.number().int(),
  periodKey: z.string(),
  version: z.number().int(),
  status: z.enum(["DRAFT", "POSTED", "EXPORTED", "REVERSED", "FAILED"]),
  reconciliationStatus: z.enum(["UNRECONCILED", "RECONCILED", "DISPUTED"]),
  reversalOfBatchId: z.number().int().nullable(),
  provisional: z.boolean(),
  totalDebits: z.string(),
  totalCredits: z.string(),
  lineCount: z.number().int(),
  unmappedCodes: z.array(z.string()),
  runId: z.number().int().nullable(),
  note: z.string().nullable(),
  reversalReason: z.string().nullable(),
  reconciliationNote: z.string().nullable(),
  postedAt: nullableWireDate(),
  exportedAt: nullableWireDate(),
  reversedAt: nullableWireDate(),
  reconciledAt: nullableWireDate(),
  createdAt: wireDate(),
});

export const journalBatchDetailSchema = journalBatchSummarySchema.extend({
  lines: z.array(journalBatchLineSchema),
});

export const journalBatchListSchema = cursorPageSchema(journalBatchSummarySchema);

const periodReconCheckSchema = z.object({
  key: z.string(),
  label: z.string(),
  ok: z.boolean(),
  severity: z.enum(["blocker", "warning", "info"]),
  detail: z.string(),
  expected: z.string().optional(),
  actual: z.string().optional(),
  delta: z.string().optional(),
});

export const periodReconciliationReportSchema = z.object({
  periodKey: z.string(),
  mode: z.literal("export_manual"),
  honestyNote: z.string(),
  run: z
    .object({
      id: z.number().int(),
      status: z.string(),
      netTotal: z.string(),
      grossTotal: z.string(),
      employeeCount: z.number().int().nullable(),
    })
    .nullable(),
  payout: z.object({
    batchCount: z.number().int(),
    totalPaid: z.string(),
    totalPending: z.string(),
    totalFailed: z.string(),
    batches: z.array(
      z.object({
        id: z.number().int(),
        batchNumber: z.string(),
        status: z.string(),
        totalAmount: z.string(),
        itemCount: z.number().int(),
      }),
    ),
  }),
  journal: z
    .object({
      batchId: z.number().int(),
      version: z.number().int(),
      status: z.string(),
      reconciliationStatus: z.string(),
      totalDebits: z.string(),
      totalCredits: z.string(),
      lineCount: z.number().int(),
      provisional: z.boolean(),
    })
    .nullable(),
  checks: z.array(periodReconCheckSchema),
  overallOk: z.boolean(),
  blockerCount: z.number().int(),
  warningCount: z.number().int(),
});
