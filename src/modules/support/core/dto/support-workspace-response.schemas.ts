import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export const supportQueueRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  filter: z.record(z.string(), z.unknown()),
  sortOrder: z.number().int(),
  isDefault: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const supportQueueWithCountSchema = supportQueueRowSchema.and(
  z.object({ openTicketCount: z.number().int() }),
);

export const supportQueueListSchema = z.array(supportQueueWithCountSchema);

export const supportSavedViewRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  ownerMembershipId: z.number().int().nullable(),
  name: z.string(),
  filter: z.record(z.string(), z.unknown()),
  visibility: z.enum(["personal", "team", "global"]),
  sortOrder: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const supportSavedViewListSchema = z.array(supportSavedViewRowSchema);

export const supportTagRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  createdAt: wireDate(),
});

export const supportTagListSchema = z.array(supportTagRowSchema);

export const supportWatcherSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  ticketId: z.number().int(),
  createdAt: wireDate(),
  userId: z.string().nullable(),
  user: z.object({
    id: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
  }).nullable(),
});

export const supportWatcherListSchema = z.array(supportWatcherSchema);

export { successSchema };
