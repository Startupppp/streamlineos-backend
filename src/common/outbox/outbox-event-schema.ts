import { z } from "zod";

export const OUTBOX_EVENT_SCHEMA_VERSION = 1;

export const outboxEventInputSchema = z.object({
  eventId: z.string().uuid(),
  organizationId: z.string().min(1),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  aggregateVersion: z.number().int().positive(),
  eventType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: z.date(),
  schemaVersion: z.number().int().positive().default(OUTBOX_EVENT_SCHEMA_VERSION),
  audience: z.enum(["INTERNAL", "PORTAL"]).default("INTERNAL"),
  actorMembershipId: z.string().min(1).nullable().default(null),
  causationId: z.string().uuid().nullable().default(null),
  correlationId: z.string().uuid().nullable().default(null),
});

export type OutboxEventInput = z.input<typeof outboxEventInputSchema>;

export const dealClosedPayloadSchema = z.object({
  dealId: z.number().int().positive(),
  orgId: z.string().min(1),
  dealName: z.string(),
  dealValue: z.string(),
  closedAt: z.string(),
  actorUserId: z.string().min(1),
});

