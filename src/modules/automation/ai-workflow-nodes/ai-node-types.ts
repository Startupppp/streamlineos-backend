import { z } from "zod";

export const classifyNodeConfigSchema = z.object({
  labels: z.array(z.string().min(1)).min(2).max(20),
  field: z.string().min(1),
});

export const classifyNodeOutputSchema = z.object({
  label: z.string(),
  confidence: z.number().optional(),
});

export const summarizeNodeConfigSchema = z.object({
  fields: z.array(z.string().min(1)).min(1),
});

export const summarizeNodeOutputSchema = z.object({
  summary: z.string(),
});

export const extractNodeConfigSchema = z.object({
  fields: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().min(1),
        type: z.enum(["string", "number", "boolean"]),
      }),
    )
    .min(1),
});

export const extractNodeOutputSchema = z.object({
  extracted: z.record(z.string(), z.unknown()),
});

export const routingSuggestionNodeConfigSchema = z.object({
  options: z.array(z.string().min(1)).min(1),
  field: z.string().min(1),
});

export const routingSuggestionNodeOutputSchema = z.object({
  suggestion: z.string(),
  reasoning: z.string(),
  proposalToken: z.string(),
});

export type ClassifyNodeConfig = z.infer<typeof classifyNodeConfigSchema>;
export type ClassifyNodeOutput = z.infer<typeof classifyNodeOutputSchema>;

export type SummarizeNodeConfig = z.infer<typeof summarizeNodeConfigSchema>;
export type SummarizeNodeOutput = z.infer<typeof summarizeNodeOutputSchema>;

export type ExtractNodeConfig = z.infer<typeof extractNodeConfigSchema>;
export type ExtractNodeOutput = z.infer<typeof extractNodeOutputSchema>;

export type RoutingSuggestionNodeConfig = z.infer<typeof routingSuggestionNodeConfigSchema>;
export type RoutingSuggestionNodeOutput = z.infer<typeof routingSuggestionNodeOutputSchema>;

export type AiNodeType = "classify" | "summarize" | "extract" | "routing_suggestion";

export type AiNodeConfig =
  | ClassifyNodeConfig
  | SummarizeNodeConfig
  | ExtractNodeConfig
  | RoutingSuggestionNodeConfig;

export type AiNodeOutput =
  | ClassifyNodeOutput
  | SummarizeNodeOutput
  | ExtractNodeOutput
  | RoutingSuggestionNodeOutput;
