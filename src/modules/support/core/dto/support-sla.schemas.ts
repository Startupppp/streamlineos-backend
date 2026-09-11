import { z } from "zod";
import { ticketStatusSchema, ticketPrioritySchema } from "./support-tickets.schemas";

const weekdayScheduleSchema = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm format"),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm format"),
});

const weeklyScheduleSchema = z.object({
  mon: weekdayScheduleSchema.optional(),
  tue: weekdayScheduleSchema.optional(),
  wed: weekdayScheduleSchema.optional(),
  thu: weekdayScheduleSchema.optional(),
  fri: weekdayScheduleSchema.optional(),
  sat: weekdayScheduleSchema.optional(),
  sun: weekdayScheduleSchema.optional(),
});

export const createBusinessHoursSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  timezone: z.string().trim().min(1).max(100).default("UTC"),
  weeklySchedule: weeklyScheduleSchema.default({}),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format")).max(100).default([]),
  is24x7: z.boolean().default(false),
  isDefault: z.boolean().default(false),
}).strict();

export const updateBusinessHoursSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  weeklySchedule: weeklyScheduleSchema.optional(),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(100).optional(),
  is24x7: z.boolean().optional(),
  isDefault: z.boolean().optional(),
}).strict();

export const createSlaPolicySchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  priority: ticketPrioritySchema.optional(),
  category: z.string().trim().max(100).optional(),
  businessHoursId: z.number().int().positive().optional(),
  firstResponseTargetMins: z.number().int().positive(),
  resolutionTargetMins: z.number().int().positive(),
  // Capped: five distinct statuses exist, so anything above that is repetition
  // an attacker can send unboundedly. `check:bulk-id-limits` only inspects
  // properties named `ids`/`*Ids`, so this one was never in its scope.
  pauseStatuses: z.array(ticketStatusSchema).max(5).default(["WAITING"]),
  isEnabled: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
}).strict();

export const updateSlaPolicySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  priority: ticketPrioritySchema.nullable().optional(),
  category: z.string().trim().max(100).nullable().optional(),
  businessHoursId: z.number().int().positive().nullable().optional(),
  firstResponseTargetMins: z.number().int().positive().optional(),
  resolutionTargetMins: z.number().int().positive().optional(),
  pauseStatuses: z.array(ticketStatusSchema).max(5).optional(),
  isEnabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
}).strict();

export type CreateBusinessHoursInput = z.infer<typeof createBusinessHoursSchema>;
export type UpdateBusinessHoursInput = z.infer<typeof updateBusinessHoursSchema>;
export type CreateSlaPolicyInput = z.infer<typeof createSlaPolicySchema>;
export type UpdateSlaPolicyInput = z.infer<typeof updateSlaPolicySchema>;
