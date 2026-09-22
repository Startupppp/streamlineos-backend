import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

const meetingRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  meetingNumber: z.number().int(),
  title: z.string(),
  type: z.string(),
  status: z.string(),
  agenda: z.string().nullable(),
  notes: z.string().nullable(),
  scheduledAt: nullableWireDate(),
  endAt: nullableWireDate(),
  durationMinutes: z.number().int().nullable(),
  timezone: z.string().nullable(),
  recurrenceRule: z.unknown(),
  cycleId: z.number().int().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const meetingListItemSchema = meetingRowSchema.extend({
  attendeeCount: z.number().int(),
  actionItemCount: z.number().int(),
  unresolvedActionItemCount: z.number().int(),
});

const meetingAttendeeSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  meetingId: z.number().int(),
  membershipId: z.number().int(),
  attended: z.boolean(),
  createdAt: wireDate(),
});

const actionItemRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  meetingId: z.number().int(),
  projectId: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  assigneeId: z.string().nullable(),
  dueDate: z.string().nullable(),
  status: z.string(),
  convertedTicketId: z.number().int().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

const standupEntrySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  meetingId: z.number().int(),
  userId: z.string(),
  membershipId: z.number().int().nullable(),
  yesterday: z.string().nullable(),
  today: z.string().nullable(),
  blockers: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const meetingDetailSchema = meetingRowSchema.extend({
  attendees: z.array(meetingAttendeeSchema),
  actionItems: z.array(actionItemRowSchema),
  standupEntries: z.array(standupEntrySchema),
});

export { meetingRowSchema as meetingSchema, actionItemRowSchema, standupEntrySchema };

export const addAttendeeResultSchema = z.object({
  meetingId: z.number().int(),
  userId: z.string(),
});

export const convertToTaskResultSchema = z.object({
  actionItem: actionItemRowSchema,
  ticketId: z.number().int(),
});
