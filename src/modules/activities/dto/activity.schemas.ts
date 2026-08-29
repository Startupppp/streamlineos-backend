import { z } from "zod";
import { ACTIVITY_KINDS } from "../../../db/schema/crm/activities";
import { queryBoolean } from "../../../common/validation/query-boolean";

const anchorFields = {
  partyId: z.string().trim().min(1).optional(),
  /**
   * A deal id, which is a `serial` and so an integer.
   *
   * Coerced rather than required as a number: this used to be a free string and
   * a client sending `"42"` must keep working. The upper bound is the `serial`
   * ceiling -- a value above it is not a deal id whatever it parses to, and the
   * check belongs here now that the column itself is typed.
   */
  dealId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  subjectId: z.string().trim().min(1).optional(),
};

const participantSchema = z
  .object({
    partyId: z.string().trim().min(1).optional(),
    userId: z.string().trim().min(1).optional(),
    address: z.string().trim().max(320).optional(),
    role: z.enum(["from", "to", "cc", "attendee", "organiser"]).default("attendee"),
  })
  .strict()
  .refine(
    (value) => Boolean(value.partyId ?? value.userId ?? value.address),
    "A participant needs a party, a user or an address",
  );

export const createActivitySchema = z
  .object({
    kind: z.enum(ACTIVITY_KINDS),
    ...anchorFields,
    occurredAt: z.string().datetime().optional(),
    subject: z.string().trim().max(500).optional(),
    body: z.string().max(20_000).optional(),
    threadId: z.string().trim().max(500).optional(),
    dueAt: z.string().datetime().optional(),
    assigneeUserId: z.string().trim().min(1).optional(),
    participants: z.array(participantSchema).max(100).default([]),
  })
  .strict()
  .refine(
    (value) => Boolean(value.partyId ?? value.dealId ?? value.subjectId),
    "An activity has to belong to a party, a deal or a subject",
  )
  .refine(
    (value) => value.kind === "task" || value.dueAt === undefined,
    "Only a task carries a due date",
  );

export const updateActivitySchema = z
  .object({
    subject: z.string().trim().max(500).nullish(),
    body: z.string().max(20_000).nullish(),
    dueAt: z.string().datetime().nullish(),
    assigneeUserId: z.string().trim().min(1).nullish(),
  })
  .strict();

export const timelineQuerySchema = z
  .object({
    ...anchorFields,
    kind: z.enum(ACTIVITY_KINDS).optional(),
    cursor: z.string().optional(),
    // The platform page cap. A timeline of thousands is read a page at a time.
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()
  .refine(
    (value) => Boolean(value.partyId ?? value.dealId ?? value.subjectId),
    "A timeline is read for a party, a deal or a subject",
  );

export const myTasksQuerySchema = z
  .object({
    includeCompleted: queryBoolean.default(false),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type CreateActivityInput = z.infer<typeof createActivitySchema>;
export type UpdateActivityInput = z.infer<typeof updateActivitySchema>;
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;
export type MyTasksQuery = z.infer<typeof myTasksQuerySchema>;
