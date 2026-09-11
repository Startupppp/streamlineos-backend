import { z } from "zod";
import { pageSizeField } from "../../../common/pagination/list-query.schema";

const CHANNELS = ["IN_APP", "EMAIL", "PUSH", "SMS", "WHATSAPP", "WEBHOOK"] as const;
const CATEGORIES = ["SECURITY", "CRM", "HRMS", "BILLING", "AI", "PROJECTS", "WORKFLOW", "MARKETING", "SYSTEM"] as const;

export const createTemplateSchema = z.object({
  templateKey: z.string().min(1).max(100).regex(/^[a-z0-9_.-]+$/, "Template key must be lowercase alphanumeric with underscores, dots, or hyphens"),
  name: z.string().min(1).max(200),
  channel: z.enum(CHANNELS),
  category: z.enum(CATEGORIES).default("SYSTEM"),
  locale: z.string().min(2).max(10).default("en"),
  subject: z.string().max(500).optional(),
  body: z.string().min(1),
  variables: z.array(z.string()).default([]),
}).strict();

export const updateTemplateSchema = createTemplateSchema.partial().omit({ templateKey: true }).strict();

export const previewTemplateSchema = z.object({
  variables: z.record(z.string(), z.string()).default({}),
}).strict();

export const testSendTemplateSchema = z.object({
  recipientId: z.string().min(1),
  variables: z.record(z.string(), z.string()).default({}),
}).strict();

export const listTemplatesSchema = z.object({
  channel: z.enum(CHANNELS).optional(),
  category: z.enum(CATEGORIES).optional(),
  isActive: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  limit: pageSizeField(50),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
export type PreviewTemplateInput = z.infer<typeof previewTemplateSchema>;
export type TestSendTemplateInput = z.infer<typeof testSendTemplateSchema>;
export type ListTemplatesInput = z.infer<typeof listTemplatesSchema>;

/**
 * COMP-004 / COMP-005. WhatsApp and SMS refuse to send a template the provider has not
 * approved. Approval happens out-of-band (Meta for WhatsApp, an Indian operator for DLT),
 * so this records the outcome — it does not perform the approval.
 *
 * `providerTemplateName` is the provider's own identifier (the DLT template id, or the
 * registered WhatsApp template name). APPROVED without one is rejected here rather than
 * at send time, because an approved template with nothing to send under is a
 * misconfiguration that would otherwise surface per message.
 */
export const setTemplateApprovalSchema = z
  .object({
    approvalStatus: z.enum(["NOT_REQUIRED", "PENDING", "APPROVED", "REJECTED"]),
    providerTemplateName: z.string().min(1).max(200).nullish(),
    approvalRejectionReason: z.string().max(1000).nullish(),
  })
  .strict()
  .refine((v) => v.approvalStatus !== "APPROVED" || Boolean(v.providerTemplateName), {
    message: "An APPROVED template must carry the provider template name it sends under",
    path: ["providerTemplateName"],
  });

export type SetTemplateApprovalInput = z.infer<typeof setTemplateApprovalSchema>;
