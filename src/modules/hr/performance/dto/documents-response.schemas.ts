import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema, cursorPageSchema } from "../../../../common/openapi/response-envelopes";

const documentSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string().nullable(),
  departmentId: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  type: z.string().nullable(),
  category: z.string().nullable(),
  hasFile: z.boolean(),
  fileName: z.string().nullable(),
  fileSize: z.number().int().nullable(),
  mimeType: z.string().nullable(),
  version: z.number().int(),
  parentDocumentId: z.number().int().nullable(),
  isPublic: z.boolean(),
  isActive: z.boolean(),
  classification: z.enum(["PERSONAL", "CONFIDENTIAL", "RESTRICTED", "INTERNAL"]),
  effectiveDate: z.string().nullable(),
  expiryDate: z.string().nullable(),
  expiryReminderSent: z.boolean(),
  tags: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  uploadedBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listDocumentsResponseSchema = z.object({
  data: z.array(documentSchema),
  pageInfo: z.object({ limit: z.number().int(), hasMore: z.boolean(), nextCursor: z.string().nullable() }),
});

export const createDocumentResponseSchema = documentSchema;

export const getDocumentFileResponseSchema = z.object({
  url: z.string(),
  fileName: z.string(),
  expiresIn: z.number().int(),
});

export const documentStatsResponseSchema = z.object({
  total: z.number().int(),
  byType: z.record(z.string(), z.number().int()),
  publicCount: z.number().int(),
  storageBytes: z.number(),
  expiringIn30Days: z.number().int(),
});

const certificationSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  name: z.string(),
  issuer: z.string().nullable(),
  issuedDate: z.string().nullable(),
  expiryDate: z.string().nullable(),
  fileUrl: z.string().nullable(),
  createdAt: wireDate(),
});

export const documentExpiryResponseSchema = z.object({
  expiringDocuments: z.array(documentSchema),
  expiringCertifications: z.array(certificationSchema.extend({ user: z.object({ id: z.string(), name: z.string().nullable() }) })),
  totalExpiring: z.number().int(),
});

export const updateDocumentResponseSchema = documentSchema;

const policyAcknowledgmentSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  documentId: z.number().int(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  status: z.enum(["PENDING", "ACKNOWLEDGED"]),
  acknowledgedAt: nullableWireDate(),
  ipAddress: z.string().nullable(),
  createdAt: wireDate(),
  document: documentSchema.nullable(),
  user: z.object({ id: z.string(), name: z.string().nullable() }),
});

export const listComplianceResponseSchema = z.array(policyAcknowledgmentSchema);

export const sendComplianceResponseSchema = z.object({ success: z.literal(true), sent: z.number().int() });

export const acknowledgeComplianceResponseSchema = successSchema;

const complianceCheckSchema = z.object({ name: z.string(), status: z.enum(["COMPLIANT", "WARNING", "ACTION_NEEDED"]), pending: z.number().int(), description: z.string() });

export const statutoryResponseSchema = z.object({
  totalEmployees: z.number().int(),
  overallComplianceScore: z.number().int(),
  checks: z.array(complianceCheckSchema),
});

const calendarEventSchema = z.object({
  date: z.string(),
  type: z.enum(["document_expiry", "certification_expiry"]),
  title: z.string(),
  entityId: z.number().int(),
  entityName: z.string(),
});

export const complianceCalendarResponseSchema = z.object({
  events: z.array(calendarEventSchema),
  year: z.number().int(),
  month: z.number().int(),
});

const richDocumentSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  contentJson: z.record(z.string(), z.unknown()).nullable(),
  templateType: z.string().nullable(),
  isPublished: z.boolean(),
  version: z.number().int(),
  createdBy: z.string(),
  updatedBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const richDocSummarySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  templateType: z.string().nullable(),
  isPublished: z.boolean(),
  version: z.number().int(),
  createdBy: z.string(),
  updatedBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listRichDocumentsResponseSchema = cursorPageSchema(richDocSummarySchema);
export const createRichDocumentResponseSchema = richDocumentSchema;
export const getRichDocumentResponseSchema = richDocumentSchema;
export const publishRichDocumentResponseSchema = successSchema;
export const updateRichDocumentResponseSchema = successSchema;

export const listLettersResponseSchema = z.array(z.object({
  id: z.number().int(),
  templateId: z.number().int(),
  templateVersion: z.number().int(),
  renderedForEmploymentId: z.number().int().nullable(),
  renderedBy: z.string(),
  createdAt: wireDate(),
  templateName: z.string(),
  templateLetterType: z.string().nullable(),
  rendererName: z.string().nullable(),
}));

export const renderLetterResponseSchema = z.object({
  templateId: z.number().int(),
  templateVersion: z.number().int(),
  templateName: z.string(),
  letterType: z.string().nullable(),
  outputHtml: z.string(),
  variables: z.array(z.string()),
  contextSnapshot: z.record(z.string(), z.string()),
  employmentId: z.number().int().optional(),
});

export const saveLetterResponseSchema = z.object({
  id: z.number().int(),
  templateId: z.number().int(),
  templateVersion: z.number().int(),
  renderedForEmploymentId: z.number().int().nullable(),
  renderedBy: z.string(),
  createdAt: wireDate(),
  templateName: z.string(),
  templateLetterType: z.string().nullable(),
  rendererName: z.string().nullable(),
});
