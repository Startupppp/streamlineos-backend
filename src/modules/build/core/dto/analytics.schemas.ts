import { z } from "zod";

export const burnupQuerySchema = z.object({
  cycleId: z.string().regex(/^\d+$/).optional(),
}).strict();

export const cfdQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(180).default(30),
}).strict();

export const velocityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().min(1).max(512).optional(),
}).strict();

const velocityTimestampSchema = z.iso.datetime({ local: true });
export const velocityCursorPositionSchema = z.object({
  sortValue: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/)
    .refine(value => !value.startsWith("0000-") && velocityTimestampSchema.safeParse(value.replace(" ", "T")).success),
  id: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647)),
});

export const resourceAllocationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
}).strict();

export const resourceAllocationCursorPositionSchema = z.object({
  sortValue: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0)),
  id: z.string().min(1),
}).transform((position) => ({ totalOpen: position.sortValue, id: position.id }));

export const projectAnalyticsQuerySchema = z.object({
  range: z.enum(["7d", "30d", "90d"]).optional(),
  teamId: z.coerce.number().int().positive().optional(),
  ownerId: z.string().optional(),
}).strict();

export type ResourceAllocationQuery = z.infer<typeof resourceAllocationQuerySchema>;
export type BurnupQuery = z.infer<typeof burnupQuerySchema>;
export type CfdQuery = z.infer<typeof cfdQuerySchema>;
export type VelocityQuery = z.infer<typeof velocityQuerySchema>;
export type ProjectAnalyticsQuery = z.infer<typeof projectAnalyticsQuerySchema>;
