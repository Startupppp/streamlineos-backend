import { z } from "zod";

const TYPES = ["INFO", "SUCCESS", "WARNING", "ERROR"] as const;
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;
const CATEGORIES = ["SECURITY", "CRM", "HRMS", "BILLING", "AI", "PROJECTS", "WORKFLOW", "MARKETING", "SYSTEM"] as const;
const CHANNELS = ["IN_APP", "EMAIL", "PUSH", "SMS", "WHATSAPP", "SLACK", "TEAMS", "WEBHOOK"] as const;
const STATUSES = ["DRAFT", "SCHEDULED", "QUEUED", "SENDING", "SENT", "CANCELLED", "FAILED"] as const;
const AUDIENCE_TYPES = ["all", "roles", "departments", "users"] as const;

const audienceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }),
  z.object({ type: z.literal("roles"), roleIds: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("departments"), departmentIds: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("users"), userIds: z.array(z.string()).min(1) }),
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
});

export const updateBroadcastSchema = createBroadcastSchema.partial();

export const listBroadcastsSchema = z.object({
  status: z.enum(STATUSES).optional(),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
  cursor: z.coerce.number().optional(),
});

export type CreateBroadcastInput = z.infer<typeof createBroadcastSchema>;
export type UpdateBroadcastInput = z.infer<typeof updateBroadcastSchema>;
export type ListBroadcastsInput = z.infer<typeof listBroadcastsSchema>;
