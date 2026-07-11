import { z } from "zod";

export const DOCUMENT_TYPES = [
  "CONTRACT",
  "CERTIFICATE",
  "ID_PROOF",
  "PAYSLIP",
  "POLICY",
  "OFFER_LETTER",
  "RESUME",
  "OTHER",
] as const;

export const createDocumentSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(DOCUMENT_TYPES),
  fileUrl: z.string().url(),
  fileName: z.string().optional(),
  fileSize: z.number().int().positive().optional(),
  mimeType: z.string().optional(),
  userId: z.string().optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  isPublic: z.boolean().optional().default(false),
  expiryDate: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const updateDocumentSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional().nullable(),
  type: z.enum(DOCUMENT_TYPES).optional(),
  category: z.string().max(100).optional().nullable(),
  userId: z.string().optional().nullable(),
  isPublic: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  expiryDate: z.string().optional().nullable(),
});

export const listDocumentsSchema = z.object({
  userId: z.string().optional(),
  type: z.string().optional(),
});

export const sendAckSchema = z.object({
  documentId: z.number().int().positive(),
  userIds: z.array(z.string().min(1)).min(1, "At least one user required"),
});

export const ackSchema = z.object({
  acknowledgmentId: z.number().int().positive(),
  status: z.enum(["ACKNOWLEDGED", "DECLINED"]),
});

export const createRichDocumentSchema = z.object({
  title: z.string(),
  templateType: z.string().optional(),
  contentJson: z.unknown().optional(),
});

export const updateRichDocumentSchema = z.object({
  title: z.string().optional(),
  contentJson: z.unknown().optional(),
});

export const renderLetterSchema = z.object({
  templateId: z.number().int().positive(),
  employeeId: z.number().int().positive().optional(),
  extraContext: z.record(z.string(), z.string()).optional(),
});

export const saveLetterSchema = z.object({
  templateId: z.number().int().positive(),
  templateVersion: z.number().int().positive(),
  employeeId: z.number().int().positive().optional(),
  outputHtml: z.string().min(1),
  contextSnapshot: z.record(z.string(), z.unknown()).optional(),
});

export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;
export type ListDocumentsInput = z.infer<typeof listDocumentsSchema>;
export type SendAckInput = z.infer<typeof sendAckSchema>;
export type AckInput = z.infer<typeof ackSchema>;
export type CreateRichDocumentInput = z.infer<typeof createRichDocumentSchema>;
export type UpdateRichDocumentInput = z.infer<typeof updateRichDocumentSchema>;
export type RenderLetterInput = z.infer<typeof renderLetterSchema>;
export type SaveLetterInput = z.infer<typeof saveLetterSchema>;
