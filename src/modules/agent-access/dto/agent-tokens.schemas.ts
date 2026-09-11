import { z } from "zod";

export const createAgentTokenSchema = z.object({
  name: z.string().min(1).max(100),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  scopes: z.array(z.string().min(1)).min(1).max(100).optional(),
}).strict();

export const agentCommentSchema = z.object({
  body: z.string().min(1).max(5000),
}).strict();

export const agentUpdateTicketSchema = z.object({
  status: z.string().min(1),
  expectedUpdatedAt: z.string().optional(),
}).strict();

export type CreateAgentTokenInput = z.infer<typeof createAgentTokenSchema>;
export type AgentCommentInput = z.infer<typeof agentCommentSchema>;
export type AgentUpdateTicketInput = z.infer<typeof agentUpdateTicketSchema>;
