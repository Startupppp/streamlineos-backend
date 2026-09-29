import { z } from "zod";

const bugStatusValues = ["new", "triaged", "assigned", "in_progress", "fixed", "ready_for_qa", "verified", "reopened", "closed"] as const;
const bugSeverityValues = ["blocker", "critical", "major", "minor", "trivial"] as const;
const bugPriorityValues = ["low", "medium", "high", "urgent"] as const;

export const bugListQuerySchema = z.object({
  status: z.enum(bugStatusValues).optional(),
  severity: z.enum(bugSeverityValues).optional(),
  assigneeId: z.string().optional(),
  q: z.string().optional(),
}).strict();

export const createBugSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  severity: z.enum(bugSeverityValues).optional(),
  priority: z.enum(bugPriorityValues).optional(),
  stepsToReproduce: z.string().optional(),
  expectedResult: z.string().optional(),
  actualResult: z.string().optional(),
  environment: z.string().optional(),
  browserDevice: z.string().optional(),
  affectedReleaseId: z.number().int().positive().optional(),
  fixedReleaseId: z.number().int().positive().optional(),
  assigneeId: z.string().optional(),
  qaOwnerId: z.string().optional(),
  linkedTicketId: z.number().int().positive().optional(),
  linkedTestCaseId: z.number().int().positive().optional(),
}).strict();

export const updateBugSchema = createBugSchema.partial().extend({
  status: z.enum(bugStatusValues).optional(),
  version: z.number().int().positive().optional(),
}).strict();

export type BugListQuery = z.infer<typeof bugListQuerySchema>;
export type CreateBugInput = z.infer<typeof createBugSchema>;
export type UpdateBugInput = z.infer<typeof updateBugSchema>;
