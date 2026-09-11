import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const payrollFilingSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  entityId: z.number().int().nullable(),
  periodId: z.number().int().nullable(),
  fiscalYear: z.string().nullable(),
  filingType: z.string(),
  ruleVersion: z.string().nullable(),
  status: z.string(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  artifactKey: z.string().nullable(),
  challanRef: z.string().nullable(),
  acknowledgementRef: z.string().nullable(),
  externalFilingRequired: z.boolean(),
  statusLabel: z.string().nullable(),
  submittedAt: nullableWireDate(),
  reconciledAt: nullableWireDate(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const payrollFilingListResponseSchema = cursorPageSchema(payrollFilingSchema);

export const filingCapabilitySchema = z.object({
  mode: z.string(),
  automaticFiling: z.boolean(),
  automaticRemittance: z.boolean(),
  providerDependent: z.boolean(),
  honestyLabel: z.string(),
  supportedTypes: z.array(z.string()),
  ruleBundleVersion: z.string(),
  artifactFormat: z.string(),
  form16Certificate: z.object({
    mode: z.string(),
    officialForm16: z.boolean(),
    honestyLabel: z.string(),
  }),
  note: z.string(),
});

export const filingExportJobViewSchema = z.object({
  jobId: z.number().int(),
  status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "DEAD_LETTER"]),
  progress: z.number().int(),
  filingId: z.number().int().nullable(),
  correlationId: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: wireDate(),
  finishedAt: nullableWireDate(),
  capability: filingCapabilitySchema,
  statusLabel: z.string(),
});

export const form16EmployeeItemSchema = z.object({
  userId: z.string(),
  employeeName: z.string(),
  employeeNumber: z.string().nullable(),
  pan: z.string().nullable(),
  periodGross: z.string(),
  periodTds: z.string(),
});

export const listForm16EmployeesResponseSchema = z.object({
  filingId: z.number().int(),
  honestyLabel: z.string(),
  employees: z.array(form16EmployeeItemSchema),
});

export const filingCapabilitiesResponseSchema = z.object({
  mode: z.literal("export_only"),
  automaticFiling: z.boolean(),
  automaticRemittance: z.boolean(),
  providerDependent: z.boolean(),
  honestyLabel: z.string(),
  supportedTypes: z.array(z.string()),
  ruleBundleVersion: z.string(),
  artifactFormat: z.literal("csv"),
  form16Certificate: z.object({
    mode: z.literal("period_summary_pdf"),
    officialForm16: z.boolean(),
    honestyLabel: z.string(),
  }),
  note: z.string(),
  ruleEffectiveFrom: z.string(),
  formLabels: z.object({
    quarterlyReturn: z.string(),
    annualCertificate: z.string(),
  }),
});

export const payrollFilingDetailSchema = payrollFilingSchema.extend({
  capability: filingCapabilitySchema,
});
