import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

export const birthdayEntrySchema = z.array(
  z.object({
    id: z.string(),
    name: z.string().nullable(),
    designation: z.string().nullable(),
    image: z.string().nullable(),
    type: z.enum(["birthday", "anniversary"]),
    date: z.string(),
    yearsCompleted: z.number().int().optional(),
  }),
);

const announcementRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  content: z.string(),
  isPinned: z.boolean(),
  expiresAt: nullableWireDate(),
  status: z.string(),
  authorId: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const announcementCreateSchema = announcementRowSchema;

export const announcementDeleteSchema = z.object({ success: z.literal(true) });

export const executiveDashboardSchema = z.object({
  headcount: z.number().int(),
  openRoles: z.number().int(),
  activeProjects: z.number().int(),
  mrr: z.number().optional(),
  pipelineValue: z.number().optional(),
  newLeadsThisWeek: z.number().int().optional(),
  conversionRate: z.number().int().optional(),
});

export const pendingApprovalsSchema = z.object({
  pendingLeaves: z.number().int(),
  pendingResignations: z.number().int(),
  total: z.number().int(),
});

export const recentActivitySchema = z.array(
  z.object({
    id: z.number().int(),
    title: z.string(),
    status: z.string().nullable(),
    type: z.string().nullable(),
    priority: z.string().nullable(),
    ticketNumber: z.number().int().nullable(),
    updatedAt: wireDate(),
    projectName: z.string(),
    projectId: z.number().int().optional(),
    projectKey: z.string(),
    assignee: z
      .object({
        id: z.number().int(),
        firstName: z.string().nullable(),
        lastName: z.string().nullable(),
        image: z.string().nullable(),
      })
      .nullable(),
  }),
);

export const teamAvailabilitySchema = z.array(
  z.object({
    userId: z.string(),
    name: z.string(),
    image: z.string().nullable(),
    checkIn: z.string().nullable(),
    checkOut: z.string().nullable(),
    isOnline: z.boolean(),
  }),
);

export const teamAttendanceSchema = teamAvailabilitySchema;

export const todayActivitiesSchema = z.array(
  z.object({
    type: z.string().nullable(),
    subject: z.string().nullable(),
  }),
);
