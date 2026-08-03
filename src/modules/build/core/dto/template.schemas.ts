import { z } from "zod";

import { refineEndAfterStart } from "./project-core.schemas";

const templateTicketSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  type: z.string().default("TASK"),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
  estimatedHours: z.number().positive().optional(),
  order: z.number().int().default(0),
  phase: z.string().optional(),
});

export const createTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  category: z.string().default("GENERAL"),
  tickets: z.array(templateTicketSchema).default([]),
});

export const applyTemplateSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().optional(),
    managerId: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    refineEndAfterStart(data, ctx);
  });

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type ApplyTemplateInput = z.infer<typeof applyTemplateSchema>;
