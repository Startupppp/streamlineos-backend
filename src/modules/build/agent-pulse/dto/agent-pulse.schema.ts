import { z } from "zod";

export const agentPulseQuerySchema = z
  .object({
    projectId: z.coerce.number().int().positive().optional(),
    managedProductId: z.coerce.number().int().positive().optional(),
    pmWorkspaceId: z.string().min(1).optional(),
  })
  .strict();

export type AgentPulseQuery = z.infer<typeof agentPulseQuerySchema>;

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
  evidence: z.string().nullable().optional(),
  proposedChange: z.string().nullable().optional(),
  impact: z.string().nullable().optional(),
  confidence: z.number().int().min(0).max(100).nullable().optional(),
  affectedRecordIds: z.array(z.number().int()).nullable().optional(),
  retryCount: z.number().int().nonnegative().optional(),
});

export const agentPulseResponseSchema = agentPulseSignalSchema.nullable();

export type AgentPulseSignal = z.infer<typeof agentPulseSignalSchema>;
export type AgentPulseSignalType = z.infer<typeof agentPulseSignalTypeSchema>;
