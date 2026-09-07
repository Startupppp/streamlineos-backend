import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

const signAuditEventSummarySchema = z.object({
  id: z.number().int(),
  envelopeId: z.number().int().nullable(),
  recipientId: z.number().int().nullable(),
  actorType: z.string(),
  actorName: z.string().nullable(),
  actorEmail: z.string().nullable(),
  eventType: z.string(),
  eventMessage: z.string().nullable(),
  createdAt: wireDate(),
});

export const signDashboardResponseSchema = z.object({
  awaitingMe: z.number().int(),
  sentPending: z.number().int(),
  completedThisMonth: z.number().int(),
  expiringSoon: z.number().int(),
  failedOrBounced: z.number().int(),
  recentActivity: z.array(signAuditEventSummarySchema),
});

export const signSummaryResponseSchema = z.object({
  byStatus: z.record(z.string(), z.number().int()),
  avgTimeToSignHours: z.number().nullable(),
  completionRate: z.number(),
  declineRate: z.number(),
  expiringSoonCount: z.number().int(),
  senderPerformance: z.array(
    z.object({
      senderMembershipId: z.number().int().nullable(),
      senderName: z.string().nullable(),
      sentCount: z.number().int(),
    }),
  ),
  templateUsage: z.array(
    z.object({
      templateId: z.number().int().nullable(),
      templateName: z.string(),
      value: z.number().int(),
    }),
  ),
  bulkSendStats: z.object({
    totalJobs: z.number().int(),
    totalRows: z.number(),
    successRows: z.number(),
    failedRows: z.number(),
  }).nullable(),
  authFailures: z.number().int(),
  watermarkUsageCount: z.number().int(),
});

const signCertificateRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  envelopeId: z.number().int(),
  certificateNumber: z.string(),
  certificateFileKey: z.string(),
  finalPdfFileKey: z.string(),
  finalPdfHash: z.string(),
  watermarked: z.boolean(),
  generatedAt: wireDate(),
  certificateJson: z.record(z.string(), z.unknown()),
});

const signAuditEventFullSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  envelopeId: z.number().int().nullable(),
  recipientId: z.number().int().nullable(),
  actorType: z.string(),
  actorUserId: z.string().nullable(),
  actorName: z.string().nullable(),
  actorEmail: z.string().nullable(),
  eventType: z.string(),
  eventMessage: z.string().nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  geolocationJson: z.record(z.string(), z.unknown()).nullable(),
  documentHash: z.string().nullable(),
  requestId: z.string().nullable(),
  eventPayloadJson: z.record(z.string(), z.unknown()).nullable(),
  createdAt: wireDate(),
});

export const listAuditEventsResponseSchema = z.array(signAuditEventFullSchema);

export const getCertificateUrlResponseSchema = z.object({
  url: z.string(),
  expiresInSeconds: z.number().int(),
  certificate: signCertificateRowSchema,
});

export const getFinalPdfUrlResponseSchema = z.object({
  url: z.string(),
  expiresInSeconds: z.number().int(),
  hash: z.string().nullable(),
});

export const regenerateCertificateResponseSchema = signCertificateRowSchema;

export const signAiSummarizeResponseSchema = z.object({ summary: z.string() });
