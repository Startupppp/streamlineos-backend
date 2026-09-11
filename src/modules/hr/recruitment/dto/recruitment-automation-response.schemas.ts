import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const pipelineAutomationSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  trigger: z.string(),
  triggerConditions: z.record(z.string(), z.unknown()),
  action: z.string(),
  actionPayload: z.record(z.string(), z.unknown()),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const pipelineAutomationWithCreatorSchema = pipelineAutomationSchema.extend({
  creator: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
});

export const candidateMessageSchema = z.object({
  id: z.number().int(),
  candidateId: z.number().int(),
  direction: z.string(),
  channel: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  sentBy: z.string().nullable(),
  sentAt: wireDate(),
  readAt: nullableWireDate(),
  externalId: z.string().nullable(),
  senderName: z.string().nullable(),
  candidateFirstName: z.string().nullable(),
  candidateLastName: z.string().nullable(),
  candidateEmail: z.string().nullable(),
});

export const candidateMessageRawSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  candidateId: z.number().int(),
  direction: z.string(),
  channel: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  sentBy: z.string().nullable(),
  sentAt: wireDate(),
  readAt: nullableWireDate(),
  externalId: z.string().nullable(),
  createdAt: wireDate(),
});

export const messageThreadItemSchema = z.object({
  candidateId: z.number().int(),
  lastMessageAt: nullableWireDate(),
  messageCount: z.number().int(),
  unreadCount: z.number().int(),
  lastBody: z.string().nullable(),
  lastDirection: z.string().nullable(),
  candidateFirstName: z.string().nullable(),
  candidateLastName: z.string().nullable(),
  candidateEmail: z.string().nullable(),
});

export const emailSequenceStepSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  sequenceId: z.number().int(),
  stepOrder: z.number().int(),
  delayDays: z.number().int(),
  subject: z.string(),
  htmlBody: z.string(),
  createdAt: wireDate(),
});

const emailSequenceBaseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  triggerType: z.string(),
  targetAudience: z.record(z.string(), z.unknown()),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const emailSequenceWithStepsSchema = emailSequenceBaseSchema.extend({
  steps: z.array(emailSequenceStepSchema),
});

export const emailSequenceListItemSchema = emailSequenceBaseSchema.extend({
  steps: z.array(emailSequenceStepSchema),
  enrollments: z.array(z.object({ id: z.number().int(), status: z.string() })),
  creator: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
});

export const emailSequenceDetailSchema = emailSequenceBaseSchema.extend({
  steps: z.array(emailSequenceStepSchema),
  enrollments: z.array(z.object({
    id: z.number().int(),
    status: z.string(),
    candidateId: z.number().int(),
    nextSendAt: nullableWireDate(),
  })),
  creator: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
});

export const enrollSequenceResponseSchema = z.object({
  enrolled: z.number().int(),
});
