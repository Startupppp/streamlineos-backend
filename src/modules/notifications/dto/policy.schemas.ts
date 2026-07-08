import { z } from "zod";

const CHANNELS = ["IN_APP", "EMAIL", "PUSH", "SMS", "WHATSAPP", "SLACK", "TEAMS", "WEBHOOK"] as const;

const overrideSchema = z.object({
  channels: z.array(z.enum(CHANNELS)).optional(),
  muted: z.boolean().optional(),
});

export const upsertPolicySchema = z.object({
  scopeType: z.enum(["ORG", "ROLE", "DEPARTMENT", "TEAM", "PROJECT"]).optional().default("ORG"),
  scopeId: z.string().nullable().optional(),
  defaultChannels: z.array(z.enum(CHANNELS)).optional(),
  eventOverrides: z.record(z.string(), overrideSchema).optional(),
  categoryOverrides: z.record(z.string(), overrideSchema).optional(),
  moduleOverrides: z.record(z.string(), overrideSchema).optional(),
  canUserOverride: z.boolean().optional(),
});

export type UpsertPolicyInput = z.infer<typeof upsertPolicySchema>;
