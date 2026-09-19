import { z } from "zod";

export const agentPulseSignalTypeSchema = z.enum([
  "overdue_approval",
  "blocked_milestone",
  "delivery_risk",
  "dependency_change",
  "comment_draft",
]);

export const agentPulseSignalSchema = z.object({
  type: agentPulseSignalTypeSchema,
  entityId: z.number().int().positive(),
  projectId: z.number().int().nonnegative(),
  title: z.string().min(1),
  dueAt: z.string().nullable(),
});

export const agentPulseResponseSchema = agentPulseSignalSchema.nullable();

export type AgentPulseSignal = z.infer<typeof agentPulseSignalSchema>;
export type AgentPulseSignalType = z.infer<typeof agentPulseSignalTypeSchema>;
