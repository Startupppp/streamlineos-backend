import { z } from "zod";
import { pageSizeField } from "../../../common/pagination/list-query.schema";

const TYPES = ["INFO", "SUCCESS", "WARNING", "ERROR"] as const;
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;
const CATEGORIES = ["SECURITY", "CRM", "HRMS", "BILLING", "AI", "PROJECTS", "WORKFLOW", "MARKETING", "SYSTEM"] as const;
const CHANNELS = ["IN_APP", "EMAIL", "PUSH", "SMS", "WHATSAPP", "WEBHOOK"] as const;
const STATUSES = ["DRAFT", "SCHEDULED", "QUEUED", "SENDING", "SENT", "CANCELLED", "FAILED"] as const;

const audienceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }),
  z.object({ type: z.literal("roles"), roleIds: z.array(z.string()).min(1).max(50) }),
  z.object({ type: z.literal("departments"), departmentIds: z.array(z.string()).min(1).max(200) }),
  z.object({ type: z.literal("users"), userIds: z.array(z.string()).min(1).max(200) }),
]);

export const createBroadcastSchema = z.object({
  title: z.string().min(1).max(300),
  message: z.string().min(1),
  type: z.enum(TYPES).default("INFO"),
  priority: z.enum(PRIORITIES).default("NORMAL"),
  category: z.enum(CATEGORIES).default("SYSTEM"),
  channels: z.array(z.enum(CHANNELS)).min(1).default(["IN_APP"]),
  audience: audienceSchema,
  scheduledAt: z.string().datetime().optional(),
}).strict();

export const updateBroadcastSchema = createBroadcastSchema.partial().strict();

export const listBroadcastsSchema = z.object({
  status: z.enum(STATUSES).optional(),
  limit: pageSizeField(20),
  cursor: z.coerce.number().optional(),
}).strict();

export const listBroadcastInboxSchema = z.object({
  limit: pageSizeField(20),
}).strict();

export type CreateBroadcastInput = z.infer<typeof createBroadcastSchema>;
export type UpdateBroadcastInput = z.infer<typeof updateBroadcastSchema>;
export type ListBroadcastsInput = z.infer<typeof listBroadcastsSchema>;
export type ListBroadcastInboxInput = z.infer<typeof listBroadcastInboxSchema>;
