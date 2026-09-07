import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

const clientProjectSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  key: z.string(),
  status: z.string(),
  startDate: nullableWireDate(),
  targetEndDate: nullableWireDate(),
});

export const clientProjectListSchema = z.array(clientProjectSchema);

const milestoneSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  dueDate: nullableWireDate(),
  status: z.string(),
});

const taskSchema = z.object({
  id: z.number().int(),
  ticketNumber: z.number().int(),
  title: z.string(),
  status: z.string(),
  dueDate: z.string().nullable(),
});

const attachmentSchema = z.object({
  id: z.number().int(),
  filename: z.string(),
  url: z.string(),
});

const commentSchema = z.object({
  id: z.number(),
  body: z.string(),
  authorName: z.string(),
  createdAt: wireDate(),
});

export const projectOverviewSchema = z.object({
  project: clientProjectSchema,
  milestones: z.array(milestoneSchema),
  tasks: z.array(taskSchema),
  attachments: z.array(attachmentSchema),
  comments: z.array(commentSchema),
});

export const changeRequestSchema = z.object({
  id: z.number().int(),
  crNumber: z.number().int(),
  title: z.string(),
  status: z.string(),
  createdAt: wireDate(),
});
