import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

export const surveyAttemptRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  surveyId: z.number().int(),
  versionId: z.number().int(),
  participantId: z.number().int().nullable(),
  sessionId: z.number().int().nullable(),
  attemptNumber: z.number().int(),
  status: z.enum(["pending", "in_progress", "passed", "failed", "expired"]),
  score: z.number().int().nullable(),
  passed: z.boolean().nullable(),
  startedAt: nullableWireDate(),
  submittedAt: nullableWireDate(),
  expiresAt: nullableWireDate(),
});

export const surveyAttemptListSchema = z.object({
  items: z.array(surveyAttemptRowSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
});

export const surveyCertificateRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  surveyId: z.number().int(),
  participantId: z.number().int(),
  attemptId: z.number().int(),
  certificateNumber: z.string(),
  issuedAt: wireDate(),
  expiresAt: nullableWireDate(),
  fileUrl: z.string().nullable(),
});

export const surveyCertificateListSchema = z.array(surveyCertificateRowSchema);
