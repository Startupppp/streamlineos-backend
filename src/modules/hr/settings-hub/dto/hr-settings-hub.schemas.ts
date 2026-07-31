import { z } from "zod";

export const effectiveRulesQuerySchema = z.object({
  employeeId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type EffectiveRulesQuery = z.infer<typeof effectiveRulesQuerySchema>;

export const versionsQuerySchema = z.object({
  entity: z.enum(["policy", "template", "workflow"]),
  id: z.string().min(1),
});

export type VersionsQuery = z.infer<typeof versionsQuerySchema>;
