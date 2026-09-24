import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { idCursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const contentHealthSignalTypeEnum = z.enum([
  "unowned",
  "stale",
  "unverified",
  "empty",
  "overdue_review",
  "broken_link",
  "overexposed",
  "duplicate_candidate",
]);

export type ContentHealthSignalType = z.infer<typeof contentHealthSignalTypeEnum>;

export const contentHealthSignalsQuerySchema = z
  .object({
    signalType: contentHealthSignalTypeEnum,
    afterId: z.coerce.number().int().positive().optional(),
    limit: pageSizeField(50),
    spaceId: z.coerce.number().int().positive().optional(),
  })
  .strict();

export type ContentHealthSignalsQuery = z.infer<typeof contentHealthSignalsQuerySchema>;

const contentHealthSignalItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  spaceId: z.number().int().nullable(),
  status: z.string(),
  ownerMembershipId: z.number().int().nullable(),
  updatedAt: wireDate(),
  nextReviewAt: nullableWireDate(),
});

export type ContentHealthSignalItem = z.infer<typeof contentHealthSignalItemSchema>;

export const contentHealthSignalsPageSchema = idCursorPageSchema(contentHealthSignalItemSchema);

const contentHealthCountItemSchema = z.object({
  signalType: contentHealthSignalTypeEnum,
  count: z.number().int(),
});

export const contentHealthCountsSchema = z.object({
  counts: z.array(contentHealthCountItemSchema),
});

export type ContentHealthCounts = z.infer<typeof contentHealthCountsSchema>;
