import { z } from "zod";

const CHANNELS = ["IN_APP", "EMAIL", "PUSH", "SMS", "WHATSAPP", "WEBHOOK"] as const;
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;

export const updateEventPolicySchema = z.object({
  enabled: z.boolean().optional(),
  defaultPriority: z.enum(PRIORITIES).optional(),
  defaultChannels: z.array(z.enum(CHANNELS)).optional(),
  allowedChannels: z.array(z.enum(CHANNELS)).optional(),
  mandatory: z.boolean().optional(),
  userConfigurable: z.boolean().optional(),
  quietHoursBehavior: z.enum(["respect", "bypass_if_high", "always_bypass"]).optional(),
  dedupeWindowSeconds: z.number().int().min(0).optional(),
  rateLimitWindowSeconds: z.number().int().min(0).optional(),
  rateLimitMax: z.number().int().min(0).optional(),
});

export const emitEventSchema = z.object({
  eventKey: z.string().min(1),
  targetUserIds: z.array(z.string().min(1)).min(1).max(500),
  actorUserId: z.string().nullable().optional(),
  entityType: z.string().max(120).optional(),
  entityId: z.string().max(120).optional(),
  title: z.string().max(300).optional(),
  message: z.string().max(2000).optional(),
  link: z.string().max(1000).optional(),
  priority: z.enum(PRIORITIES).optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type UpdateEventPolicyInput = z.infer<typeof updateEventPolicySchema>;
export type EmitEventInput = z.infer<typeof emitEventSchema>;
