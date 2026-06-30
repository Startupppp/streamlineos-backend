import { z } from "zod";

const SECTIONS = ["ALL", "UNREAD", "READ", "ARCHIVED", "SYSTEM", "PINNED"] as const;
const CATEGORIES = ["SECURITY", "CRM", "HRMS", "BILLING", "AI", "PROJECTS", "WORKFLOW", "MARKETING", "SYSTEM"] as const;
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;

export const listSchema = z.object({
  section: z.enum(SECTIONS).optional().default("ALL"),
  category: z.enum(CATEGORIES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  sourceModule: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
  cursor: z.coerce.number().optional(),
  unreadOnly: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((value) => value === "true" || value === "1"),
});

export const snoozeSchema = z.object({
  snoozedUntil: z.string().datetime(),
});

export const bulkActionSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});

export const auditLogsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  action: z.string().min(1).optional(),
  dateFrom: z.string().min(1).optional(),
  dateTo: z.string().min(1).optional(),
});

export type ListInput = z.infer<typeof listSchema>;
export type SnoozeInput = z.infer<typeof snoozeSchema>;
export type BulkActionInput = z.infer<typeof bulkActionSchema>;
export type AuditLogsInput = z.infer<typeof auditLogsSchema>;
