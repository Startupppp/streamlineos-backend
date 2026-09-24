import { z } from "zod";

const ticketId = z.coerce.number().int().positive();
const userId = z.string().min(1).max(120);
const isoDate = z.string().min(1).max(60);
const longText = z.string().min(1).max(10_000);

export const ticketCreatePayloadSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).optional(),
  type: z.enum(["TASK", "BUG", "STORY", "EPIC", "SUBTASK"]).default("TASK"),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
  assigneeId: userId.optional(),
});

export const ticketStatusUpdatePayloadSchema = z.object({
  ticketId,
  status: z.string().trim().min(1).max(60),
  title: z.string().max(300).optional(),
  reason: z.string().max(2_000).optional(),
});

export const ticketCommentPayloadSchema = z.object({
  ticketId,
  comment: z.string().min(1).max(5_000),
});

export const ticketAssignPayloadSchema = z.object({
  ticketId,
  assigneeId: userId,
  assigneeName: z.string().max(200).optional(),
});

export const ticketCyclePayloadSchema = z.object({
  ticketId,
  cycleId: z.coerce.number().int().positive(),
  cycleName: z.string().max(200).optional(),
});

export const calendarReminderPayloadSchema = z.object({
  title: z.string().min(1).max(200),
  startDate: isoDate,
  endDate: isoDate,
  timezone: z.string().min(1).max(100).optional(),
  description: z.string().max(5_000).optional(),
  fromTicketId: ticketId.optional(),
});

export const calendarEventPayloadSchema = z.object({
  title: z.string().min(1).max(200),
  startDate: isoDate,
  endDate: isoDate,
  timezone: z.string().min(1).max(100),
  attendeeNames: z.array(z.string().min(1).max(200)).max(50).optional(),
  location: z.string().max(500).optional(),
  description: z.string().max(5_000).optional(),
});

export const scheduleMeetingPayloadSchema = z.object({
  title: z.string().min(1).max(200),
  startDate: isoDate,
  endDate: isoDate,
  timezone: z.string().min(1).max(100),
  attendeeIds: z.array(userId).max(50).default([]),
  location: z.string().max(500).optional(),
  description: z.string().max(5_000).optional(),
});

export const outboundEmailPayloadSchema = z.object({
  toEmail: z.string().email().max(320),
  subject: z.string().min(1).max(500),
  body: longText,
});

export const chatChannelPostPayloadSchema = z.object({
  channelId: z.coerce.number().int().positive(),
  channelName: z.string().max(200).optional(),
  message: z.string().min(1).max(5_000),
});

export const sendDirectMessagePayloadSchema = z.object({
  targetUserId: userId,
  message: z.string().min(1).max(5_000),
});

export const grantRecognitionPayloadSchema = z.object({
  toUserId: userId,
  message: z.string().min(1).max(2_000),
  category: z
    .enum(["KUDOS", "TEAMWORK", "INNOVATION", "LEADERSHIP", "ABOVE_AND_BEYOND"])
    .default("KUDOS"),
});

export const grantBonusPayloadSchema = z.object({
  employeeId: userId,
  type: z.string().min(1).max(60),
  amount: z.coerce.number(),
  reason: z.string().max(2_000).optional(),
  month: z.string().min(1).max(20),
  taxable: z.boolean().optional(),
});

export const mailSendPayloadSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  toEmail: z.string().email().max(320),
  subject: z.string().min(1).max(500),
  body: longText,
});

export const mailReplyPayloadSchema = z.object({
  threadId: z.string().min(1).max(500),
  body: longText,
  accountEmail: z.string().email().max(320).optional(),
});

export const mailArchivePayloadSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  messageId: z.string().min(1).max(500),
  threadId: z.string().min(1).max(500).optional(),
});

export const applyLeavePayloadSchema = z.object({
  leaveTypeId: z.coerce.number().int().positive(),
  startDate: isoDate,
  endDate: isoDate,
  reason: z.string().max(2_000).nullish(),
});

export const submitExpensePayloadSchema = z.object({
  category: z.string().min(1).max(120),
  amount: z.coerce.number(),
  description: z.string().max(2_000).nullish(),
  date: isoDate,
});

export const logTimesheetPayloadSchema = z.object({
  date: isoDate,
  hours: z.coerce.number().positive().max(24),
  projectId: z.coerce.number().int().positive().nullish(),
  description: z.string().max(2_000).nullish(),
});

export const submitReferralPayloadSchema = z.object({
  candidateName: z.string().min(1).max(200),
  candidateEmail: z.string().email().max(320),
  jobPostingId: z.coerce.number().int().positive().nullish(),
  notes: z.string().max(2_000).nullish(),
});

export const applyToJobOpeningPayloadSchema = z.object({
  jobId: z.coerce.number().int().positive(),
  coverLetter: z.string().max(5000).nullish(),
  notes: z.string().max(2000).nullish(),
});

export const createLeadPayloadSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320).optional(),
  phone: z.string().max(50).optional(),
  company: z.string().max(200).optional(),
  notes: z.string().max(2_000).optional(),
});

export const logLeadActivityPayloadSchema = z.object({
  leadIdentifier: z.coerce.number().int().positive(),
  leadName: z.string().max(200).optional(),
  type: z.string().min(1).max(60),
  notes: z.string().max(5_000).optional(),
  dueDate: isoDate.optional(),
});

export const updateLeadStatusPayloadSchema = z.object({
  leadId: z.coerce.number().int().positive(),
  leadName: z.string().max(200).optional(),
  status: z.string().min(1).max(60).optional(),
  priority: z.string().min(1).max(60).optional(),
});
