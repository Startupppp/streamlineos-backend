import { z } from "zod";
import { wireTimestamp } from "../../../common/openapi/wire-types";

const timestamp = wireTimestamp();
const nullableText = z.string().nullable();

export const dashboardStatsResponseSchema = z.object({
  orgName: z.string(),
  orgSlug: z.string(),
  totalEmployees: z.number().int().nonnegative().nullable(),
  activeProjects: z.number().int().nonnegative().nullable(),
  presentToday: z.number().int().nonnegative().nullable(),
}).strict();

export const dashboardPersonalResponseSchema = z.object({
  myTasks: z.array(z.object({
    id: z.number().int(),
    title: z.string(),
    status: z.string(),
    priority: z.string(),
    dueDate: z.null(),
    projectName: nullableText,
  }).strict()).max(10),
  timesheetStatus: z.object({
    submitted: z.boolean(),
    weekLabel: z.string(),
    hoursLogged: z.number(),
  }).strict(),
  upcomingEvents: z.array(z.object({
    id: z.number().int(),
    title: z.string(),
    startTime: timestamp,
    endTime: timestamp,
    type: z.string(),
  }).strict()),
  degraded: z.array(z.string()),
}).strict();

export const dashboardAnnouncementsResponseSchema = z.array(z.object({
  id: z.number().int(),
  content: z.string(),
  isPinned: z.boolean(),
  expiresAt: timestamp.nullable(),
  createdAt: timestamp,
  authorId: z.string(),
  authorName: nullableText,
  authorFirstName: nullableText,
  authorLastName: nullableText,
}).strict()).max(20);
