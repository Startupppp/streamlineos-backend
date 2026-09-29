import { z } from "zod";

import { refineEndAfterStart } from "./project-core.schemas";
import { ticketTypeEnum } from "../../../../db/schema";

export const listTemplatesQuerySchema = z.object({
  cursor: z.string().optional(),
  q: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(50).optional(),
  sort: z.enum(["name", "newest"]).optional(),
}).strict();
export type ListTemplatesQuery = z.infer<typeof listTemplatesQuerySchema>;

const templateTicketSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(ticketTypeEnum.enumValues).default("TASK"),
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
}).strict();

export const applyTemplateSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().optional(),
    managerId: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  }).strict()
  .superRefine((data, ctx) => {
    refineEndAfterStart(data, ctx);
  });

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type ApplyTemplateInput = z.infer<typeof applyTemplateSchema>;
