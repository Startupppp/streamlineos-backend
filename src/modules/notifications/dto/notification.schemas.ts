import { z } from "zod";
import { pageSizeField } from "../../../common/pagination/list-query.schema";

const SECTIONS = ["ALL", "UNREAD", "READ", "MENTIONS", "ASSIGNED_TO_ME", "APPROVALS", "BROADCASTS", "ARCHIVED", "SYSTEM", "PINNED"] as const;
const CATEGORIES = ["SECURITY", "CRM", "HRMS", "BILLING", "AI", "PROJECTS", "WORKFLOW", "MARKETING", "SYSTEM", "CHAT", "PAYROLL", "RECRUITMENT", "KNOWLEDGE", "SIGN", "INVENTORY", "SURVEYS", "CALENDAR", "SUPPORT"] as const;
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;

export const listSchema = z.object({
  section: z.enum(SECTIONS).optional().default("ALL"),
  category: z.enum(CATEGORIES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  sourceModule: z.string().optional(),
  search: z.string().min(1).max(200).optional(),
  limit: pageSizeField(20),
  cursor: z.coerce.number().optional(),
  unreadOnly: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((value) => value === "true" || value === "1"),
}).strict();

export const snoozeSchema = z.object({
  snoozedUntil: z.string().datetime(),
}).strict();

export const bulkActionSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
}).strict();

export type ListInput = z.infer<typeof listSchema>;
export type SnoozeInput = z.infer<typeof snoozeSchema>;
export type BulkActionInput = z.infer<typeof bulkActionSchema>;
