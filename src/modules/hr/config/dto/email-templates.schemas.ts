import { z } from "zod";

export const createEmailTemplateSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(100, "Name must be at most 100 characters"),
  subject: z.string().trim().min(2, "Subject must be at least 2 characters").max(200, "Subject must be at most 200 characters"),
  body: z.string().min(10, "Body must be at least 10 characters"),
  category: z.string().optional(),
  variables: z.array(z.string()).optional(),
}).strict();

export const updateEmailTemplateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  subject: z.string().trim().min(2).max(200).optional(),
  body: z.string().min(10).optional(),
  category: z.string().optional(),
  variables: z.array(z.string()).optional(),
}).strict();

export const generateEmailTemplateAiSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(100, "Name must be at most 100 characters"),
  subject: z.string().trim().max(200).optional(),
  category: z.string().optional(),
}).strict();

export type CreateEmailTemplateInput = z.infer<typeof createEmailTemplateSchema>;
export type UpdateEmailTemplateInput = z.infer<typeof updateEmailTemplateSchema>;
export type GenerateEmailTemplateAiInput = z.infer<typeof generateEmailTemplateAiSchema>;
