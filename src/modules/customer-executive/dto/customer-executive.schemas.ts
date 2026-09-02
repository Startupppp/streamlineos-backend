import { z } from "zod";

const weightSchema = z.object({
  sla: z.number().int().min(0).max(100),
  csat: z.number().int().min(0).max(100),
  activity: z.number().int().min(0).max(100),
  renewal: z.number().int().min(0).max(100),
  tickets: z.number().int().min(0).max(100),
});

export const updateHealthConfigSchema = z
  .object({
    weights: weightSchema,
    thresholds: z.object({
      healthy: z.number().int().min(0).max(100),
      atRisk: z.number().int().min(0).max(100),
    }).strict(),
  })
  .refine(
    (val) => val.weights.sla + val.weights.csat + val.weights.activity + val.weights.renewal + val.weights.tickets > 0,
    { message: "At least one weight must be greater than zero", path: ["weights"] },
  )
  .refine((val) => val.thresholds.healthy > val.thresholds.atRisk, {
    message: "Healthy threshold must be greater than at-risk threshold",
    path: ["thresholds", "healthy"],
  });

export const createSurveySchema = z.object({
  title: z.string().min(1).max(200),
  question: z.string().min(1).max(500),
}).strict();

export const updateSurveySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  question: z.string().min(1).max(500).optional(),
  status: z.enum(["draft", "active", "closed"]).optional(),
}).strict();

export type UpdateHealthConfigInput = z.infer<typeof updateHealthConfigSchema>;
export type CreateSurveyInput = z.infer<typeof createSurveySchema>;
export type UpdateSurveyInput = z.infer<typeof updateSurveySchema>;
