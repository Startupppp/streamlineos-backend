import { z } from "zod";

export const draftSchema = z.object({
  prompt: z.string().trim().min(3).max(2000),
  title: z.string().trim().max(300).optional(),
});
export type DraftInput = z.infer<typeof draftSchema>;

export const improveSchema = z.object({
  text: z.string().trim().min(1).max(20000),
  instruction: z.string().trim().max(500).optional(),
});
export type ImproveInput = z.infer<typeof improveSchema>;

export const summarizeSchema = z.object({
  text: z.string().trim().min(1).max(20000),
});
export type SummarizeInput = z.infer<typeof summarizeSchema>;

export const translateSchema = z.object({
  text: z.string().trim().min(1).max(20000),
  locale: z.string().trim().min(2).max(10),
});
export type TranslateInput = z.infer<typeof translateSchema>;
