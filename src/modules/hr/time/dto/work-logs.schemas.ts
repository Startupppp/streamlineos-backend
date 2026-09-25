import { z } from "zod";

export const listWorkLogsQuerySchema = z.object({
  userId: z.string().optional(),
  year: z.coerce.number(),
  quarter: z.coerce.number(),
  month: z.coerce.number().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
}).strict();

export const postWorkLogSchema = z.object({
  userId: z.string().optional(),
  date: z.string(),
  hours: z.number().optional(),
  description: z.string().optional(),
  workLink: z
    .string()
    .optional()
    .or(z.literal(""))
    .refine((v) => {
      if (!v?.trim()) return true;
      const links = v
        .split(/\n+/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (links.length > 10) return false;
      return links.every((l) => {
        try {
          new URL(l);
          return true;
        } catch {
          return false;
        }
      });
    }, "Each work link must be a valid URL (max 10)"),
}).strict();

export const exportWorkLogsQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  userId: z.string().optional(),
}).strict();

export const patchWorkLogStatusSchema = z.object({
  id: z.number(),
  status: z.enum(["APPROVED", "REJECTED"]),
  rejectionReason: z.string().optional(),
}).strict();

export type ListWorkLogsQuery = z.infer<typeof listWorkLogsQuerySchema>;
export type PostWorkLogInput = z.infer<typeof postWorkLogSchema>;
export type ExportWorkLogsQuery = z.infer<typeof exportWorkLogsQuerySchema>;
export type PatchWorkLogStatusInput = z.infer<typeof patchWorkLogStatusSchema>;
