import { z } from "zod";
import { setupInviteeSchema } from "./org.schemas";

/**
 * Closed at the boundary. A bare `z.object({})` strips an unexpected key rather than
 * rejecting it, so a producer that renamed `orgId` would parse clean and hand the consumer
 * a payload with no tenant at all — a dropped field becoming a wrong-subject write instead
 * of an error. Every field here drives a write, so nothing extra may ride along.
 *
 * `industry` and `invitees` carry defaults rather than being required: an event emitted by the
 * previous release is already sitting in the outbox when this one boots, and a `.strict()` schema
 * that required them would mark every one of those FAILED instead of provisioning it.
 */
export const orgSetupCompletedPayloadSchema = z
  .object({
    orgId: z.string().min(1),
    userId: z.string().min(1),
    moduleKeys: z.array(z.string().min(1)),
    sessionAction: z.enum(["complete", "skip"]),
    skipReason: z.string().nullable(),
    sendWelcome: z.boolean(),
    industry: z.string().nullable().default(null),
    invitees: z.array(setupInviteeSchema).default([]),
  })
  .strict();
