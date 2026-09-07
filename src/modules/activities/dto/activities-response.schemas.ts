import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

const timelineAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("party"), partyId: z.string() }),
  z.object({ kind: z.literal("deal"), dealId: z.string() }),
  z.object({ kind: z.literal("subject"), subjectId: z.string() }),
]);

const timelineEntrySchema = z.object({
  activityId: z.string(),
  kind: z.string(),
  occurredAt: wireDate(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  threadId: z.string().nullable(),
  actorKind: z.string(),
  actorLabel: z.string().nullable(),
  actorName: z.string().nullable(),
  dueAt: nullableWireDate(),
  completedAt: nullableWireDate(),
  source: z.string(),
  anchor: timelineAnchorSchema,
});

export const timelinePageSchema = z.object({
  data: z.array(timelineEntrySchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const myTasksPageSchema = timelinePageSchema;

const activityParticipantSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
});

export const activityParticipantsResponseSchema = z.object({
  data: z.array(activityParticipantSchema),
});

export const activityDeletedSchema = z.object({ deleted: z.literal(true) });

export const activityRowSchema = z.object({
  activityId: z.string(),
  kind: z.string(),
  occurredAt: wireDate(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  threadId: z.string().nullable(),
  actorKind: z.string(),
  source: z.string(),
  dueAt: nullableWireDate(),
  completedAt: nullableWireDate(),
});
