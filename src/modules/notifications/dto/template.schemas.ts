import { z } from "zod";

const CHANNELS = ["IN_APP", "EMAIL", "PUSH", "SMS", "WHATSAPP", "SLACK", "TEAMS", "WEBHOOK"] as const;
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
});

export const updateTemplateSchema = createTemplateSchema.partial().omit({ templateKey: true });

export const previewTemplateSchema = z.object({
  variables: z.record(z.string(), z.string()).default({}),
});

export const testSendTemplateSchema = z.object({
  recipientId: z.string().min(1),
  variables: z.record(z.string(), z.string()).default({}),
});

export const listTemplatesSchema = z.object({
  channel: z.enum(CHANNELS).optional(),
  category: z.enum(CATEGORIES).optional(),
  isActive: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
export type PreviewTemplateInput = z.infer<typeof previewTemplateSchema>;
export type TestSendTemplateInput = z.infer<typeof testSendTemplateSchema>;
export type ListTemplatesInput = z.infer<typeof listTemplatesSchema>;
