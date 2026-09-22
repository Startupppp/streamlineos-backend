import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

const sprintTicketItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.string(),
  points: z.number().int().nullable(),
  sprintId: z.number().int().nullable(),
});

export const sprintListItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  name: z.string(),
  startDate: wireDate(),
  endDate: wireDate(),
  goal: z.string().nullable(),
  status: z.string(),
  tickets: z.array(sprintTicketItemSchema),
});

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

export const sprintRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  name: z.string(),
  startDate: wireDate(),
  endDate: wireDate(),
  goal: z.string().nullable(),
  status: z.string(),
  deletedAt: wireDate().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const cycleListItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  startDate: z.string(),
  endDate: z.string(),
  status: z.string(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  totalItems: z.number().int(),
  completedItems: z.number().int(),
  progress: z.number().int(),
});

export const cycleRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const moduleListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  orgId: z.string(),
  status: z.string(),
  leadId: z.string().nullable(),
  endDate: z.string().nullable(),
  startDate: z.string().nullable(),
  createdBy: z.string(),
  projectId: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  description: z.string().nullable(),
  totalItems: z.number().int(),
  completedItems: z.number().int(),
  progress: z.number().int(),
});

export const moduleRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  leadId: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const userColsSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  image: z.string().nullable(),
  email: z.string(),
});

const sprintTicketWithAssigneeSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  priority: z.string(),
  projectId: z.number().int().nullable(),
  ticketNumber: z.number().int(),
  sprintId: z.number().int().nullable(),
  epicId: z.number().int().nullable(),
  assigneeMembershipId: z.number().int().nullable(),
  points: z.number().int().nullable(),
  storyPoints: z.number().int().nullable(),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  estimate: z.number().int().nullable(),
  completionPercentage: z.number().int(),
  rank: z.string(),
  timeSpent: z.string(),
  version: z.number().int(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  assignee: z.object({ user: userColsSchema }).nullable(),
});

export const sprintDetailSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  name: z.string(),
  startDate: wireDate(),
  endDate: wireDate(),
  goal: z.string().nullable(),
  status: z.string(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  tickets: z.array(sprintTicketWithAssigneeSchema),
});

export const epicRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  priority: z.string(),
  projectId: z.number().int().nullable(),
  ticketNumber: z.number().int(),
  sprintId: z.number().int().nullable(),
  epicId: z.number().int().nullable(),
  assigneeMembershipId: z.number().int().nullable(),
  points: z.number().int().nullable(),
  storyPoints: z.number().int().nullable(),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  estimate: z.number().int().nullable(),
  completionPercentage: z.number().int(),
  rank: z.string(),
  timeSpent: z.string(),
  version: z.number().int(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  assignee: z.object({ user: userColsSchema }).nullable().optional(),
});

export const memberCapacitySchema = z.object({
  userId: z.string(),
  membershipId: z.number().int(),
  workingDaysInWindow: z.number(),
  leaveDays: z.number(),
  halfLeaveDays: z.number(),
  netCapacityDays: z.number(),
  capacityHours: z.number().nullable(),
  loggedHours: z.number(),
  isOverAllocated: z.boolean(),
  isZeroCapacity: z.boolean(),
  utilizationPercent: z.number().nullable(),
});

export const workloadCapacityResponseSchema = z.object({
  members: z.array(memberCapacitySchema),
});
