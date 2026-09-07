import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

const boundedListSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    total: z.number().int(),
    hasMore: z.boolean(),
  });

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

const announcementListItemSchema = z.object({
  id: z.number().int(),
  content: z.string(),
  isPinned: z.boolean(),
  expiresAt: nullableWireDate(),
  createdAt: wireDate(),
  authorId: z.string(),
  authorName: z.string().nullable(),
  authorFirstName: z.string().nullable(),
  authorLastName: z.string().nullable(),
});

export const announcementsListSchema = z.array(announcementListItemSchema);

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

const leaveTodayItemSchema = z.object({
  id: z.number().int(),
  startDate: z.string(),
  endDate: z.string(),
  leaveTypeId: z.number().int(),
  employeeName: z.string().nullable(),
  employeeDesignation: z.string().nullable(),
  employeeImage: z.string().nullable(),
});

export const leavesTodaySchema = boundedListSchema(leaveTodayItemSchema);

const leaveBalanceItemSchema = z.object({
  id: z.number().int(),
  balance: z.number(),
  year: z.number().int(),
  leaveTypeName: z.string().nullable(),
  daysPerYear: z.number().nullable(),
});

export const myLeaveBalanceSchema = z.array(leaveBalanceItemSchema);

export const pendingApprovalsSchema = z.object({
  pendingLeaves: z.number().int(),
  pendingResignations: z.number().int(),
  total: z.number().int(),
});

export const upcomingHolidaysSchema = z.array(
  z.object({
    id: z.number().int(),
    name: z.string(),
    date: z.string(),
    message: z.string().nullable(),
  }),
);

const issueItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.string().nullable(),
  type: z.string().nullable(),
  priority: z.string().nullable(),
  ticketNumber: z.string(),
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
});

export const myIssuesSchema = z.array(issueItemSchema);

export const activeSprintSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    projectName: z.string(),
    projectId: z.number().int().optional(),
    progress: z.number().int(),
    daysRemaining: z.number().int(),
    totalTickets: z.number().int(),
    doneTickets: z.number().int(),
    inProgressTickets: z.number().int(),
    todoTickets: z.number().int(),
    totalPoints: z.number().int(),
    completedPoints: z.number().int(),
  })
  .nullable();

const projectManagerSchema = z.object({
  id: z.number().int(),
  user: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
      image: z.string().nullable(),
    })
    .nullable(),
});

export const recentProjectsSchema = z.array(
  z.object({
    id: z.number().int(),
    name: z.string(),
    key: z.string(),
    manager: projectManagerSchema.nullable().optional(),
  }),
);

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
