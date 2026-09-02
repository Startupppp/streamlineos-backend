import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";

const goalStatusEnum = z.enum([
  "not_started",
  "on_track",
  "at_risk",
  "off_track",
  "completed",
]);

const goalLevelEnum = z.enum(["company", "team", "individual"]);

const metricTypeEnum = z.enum(["number", "percentage", "currency", "boolean"]);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const listSchema = z.object({
  status: goalStatusEnum.optional(),
  level: goalLevelEnum.optional(),
  ownerId: z.string().optional(),
  projectId: z.coerce.number().int().optional(),
  search: z.string().optional(),
  page: pageNumberField,
  limit: pageSizeField(20, 100),
}).strict();

const keyResultInputSchema = z.object({
  title: z.string().min(1).max(200),
  metricType: metricTypeEnum.default("number"),
  startValue: z.number().default(0),
  targetValue: z.number(),
  currentValue: z.number().default(0),
  unit: z.string().max(50).optional(),
});

export const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  ownerId: z.string().optional(),
  level: goalLevelEnum.default("company"),
  status: goalStatusEnum.default("not_started"),
  startDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  parentGoalId: z.number().int().optional(),
  projectId: z.number().int().optional(),
  keyResults: z.array(keyResultInputSchema).optional(),
}).strict();

export const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  ownerId: z.string().nullable().optional(),
  level: goalLevelEnum.optional(),
  status: goalStatusEnum.optional(),
  startDate: isoDate.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  parentGoalId: z.number().int().nullable().optional(),
  projectId: z.number().int().nullable().optional(),
}).strict();

export const checkInSchema = z.object({
  keyResultId: z.number().int(),
  newValue: z.number(),
  note: z.string().max(1000).optional(),
}).strict();

export const createKeyResultSchema = z.object({
  title: z.string().min(1).max(200),
  metricType: metricTypeEnum.default("number"),
  startValue: z.number().default(0),
  targetValue: z.number(),
  currentValue: z.number().default(0),
  unit: z.string().max(50).optional(),
  status: goalStatusEnum.default("not_started"),
}).strict();

export const updateKeyResultSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  metricType: metricTypeEnum.optional(),
  startValue: z.number().optional(),
  targetValue: z.number().optional(),
  currentValue: z.number().optional(),
  unit: z.string().max(50).nullable().optional(),
  status: goalStatusEnum.optional(),
}).strict();

export const createLinkSchema = z
  .object({
    ticketId: z.number().int().optional(),
    projectId: z.number().int().optional(),
  }).strict()
  .refine((data) => data.ticketId !== undefined || data.projectId !== undefined, {
    message: "Provide a ticketId or projectId",
  });

export const deleteLinkSchema = z.object({
  linkId: z.coerce.number().int(),
}).strict();

export type ListInput = z.infer<typeof listSchema>;
export type CreateInput = z.infer<typeof createSchema>;
export type UpdateInput = z.infer<typeof updateSchema>;
export type CheckInInput = z.infer<typeof checkInSchema>;
export type CreateKeyResultInput = z.infer<typeof createKeyResultSchema>;
export type UpdateKeyResultInput = z.infer<typeof updateKeyResultSchema>;
export type CreateLinkInput = z.infer<typeof createLinkSchema>;
export type DeleteLinkInput = z.infer<typeof deleteLinkSchema>;
