import { z } from "zod";
import { IDENTIFIER_KINDS, INBOUND_CHANNELS, PARTICIPANT_ROLES } from "../inbound-event";

const participantSchema = z
  .object({
    address: z.string().trim().min(1).max(320),
    displayName: z.string().trim().max(200).nullish(),
    role: z.enum(PARTICIPANT_ROLES),
    /**
     * Optional on the wire, and it has to be accepted here for the field to
     * mean anything at all.
     *
     * The schema is `.strict()`, so leaving it out would reject the key rather
     * than ignore it — a caller posting an event in process would carry the
     * kind and the same caller posting it over HTTP would be refused, which is
     * a divergence between two paths that are supposed to be one seam.
     */
    identifierKind: z.enum(IDENTIFIER_KINDS).optional(),
  })
  .strict();

/**
 * The seam's wire contract.
 *
 * Every adapter — email, calendar, telephony, messaging — normalises into this
 * and hands off. There is deliberately no provider-shaped field here beyond the
 * opaque `provider` label and its message ids: the moment a provider-specific
 * key appears, the seam has leaked and adding a channel stops being free.
 */
export const inboundEventSchema = z
  .object({
    organizationId: z.string().trim().min(1),
    channel: z.enum(INBOUND_CHANNELS),
    provider: z.string().trim().min(1).max(60),
    providerMessageId: z.string().trim().min(1).max(500),
    providerThreadId: z.string().trim().max(500).nullish(),
    occurredAt: z.string().datetime(),
    subject: z.string().trim().max(500).nullish(),
    body: z.string().max(100_000).nullish(),
    participants: z.array(participantSchema).min(1).max(200),
  })
  .strict();

export type InboundEventBody = z.infer<typeof inboundEventSchema>;
