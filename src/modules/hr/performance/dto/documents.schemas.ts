import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

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

const documentFileReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (value) =>
      /^https:\/\//i.test(value) || /^(?:documents|hr-documents)\/[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(value),
    "Invalid stored document file reference",
  );

export const createDocumentSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(DOCUMENT_TYPES),
  fileUrl: documentFileReferenceSchema,
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

export const listDocumentsSchema = z
  .object({
    userId: z.string().optional(),
    type: z.enum(DOCUMENT_TYPES).optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: pageSizeField(20),
    search: z.string().trim().max(200).optional(),
    category: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const listRichDocumentsSchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20, 100),
  isPublished: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
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

const letterEmployeeTargetSchema = z
  .object({
    employmentId: z.number().int().positive().optional(),
    employeeUserId: z.string().min(1).max(255).optional(),
  })
  .refine((value) => !(value.employmentId && value.employeeUserId), {
    message: "Choose one employee target",
  });

export const renderLetterSchema = z
  .object({
    templateId: z.number().int().positive(),
    extraContext: z.record(z.string(), z.string()).optional(),
  })
  .and(letterEmployeeTargetSchema);

export const saveLetterSchema = z
  .object({
    templateId: z.number().int().positive(),
    templateVersion: z.number().int().positive(),
    outputHtml: z.string().min(1),
    contextSnapshot: z.record(z.string(), z.unknown()).optional(),
  })
  .and(letterEmployeeTargetSchema);

export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;
export type ListDocumentsInput = z.infer<typeof listDocumentsSchema>;
export type ListRichDocumentsInput = z.infer<typeof listRichDocumentsSchema>;
export type SendAckInput = z.infer<typeof sendAckSchema>;
export type AckInput = z.infer<typeof ackSchema>;
export type CreateRichDocumentInput = z.infer<typeof createRichDocumentSchema>;
export type UpdateRichDocumentInput = z.infer<typeof updateRichDocumentSchema>;
export type RenderLetterInput = z.infer<typeof renderLetterSchema>;
export type SaveLetterInput = z.infer<typeof saveLetterSchema>;
