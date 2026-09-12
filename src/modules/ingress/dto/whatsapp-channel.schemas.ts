import { z } from "zod";

/**
 * Binding a WhatsApp business line to an organisation.
 *
 * What is asked for here is the smallest set that lets a delivery be verified
 * and filed. In particular there is no field for a provider access token, and
 * that is a property being asserted rather than an omission: sending, and the
 * media download the adapter stops short of, go through Composio's connected
 * account. A channel row cannot act on the organisation's behalf, so a leak of
 * the table lets an attacker forge an inbound message onto a timeline and
 * nothing else.
 */

/** `metadata.phone_number_id` — the provider's own handle, always digits. */
const phoneNumberId = z
  .string()
  .trim()
  .min(5)
  .max(32)
  .regex(/^\d+$/, "phone_number_id is the provider's numeric handle for the line");

/** The business's own number, as the other end of the participant pair. */
const businessNumber = z
  .string()
  .trim()
  .min(5)
  .max(32)
  .regex(/^\+?[0-9 ()-]+$/, "a telephone number, in any of the usual writings");

/**
 * The app secret the provider signs deliveries with.
 *
 * Never generated here — Meta issues it and an operator copies it across, which
 * is why this is an input rather than a reveal-once output like the verify
 * token. Bounded so a paste of the wrong field (an access token, a whole JSON
 * blob) is refused at the edge rather than stored and silently failing every
 * signature afterwards.
 */
const appSecret = z.string().trim().min(16).max(512);

export const createWhatsappChannelSchema = z
  .object({
    businessPhoneNumberId: phoneNumberId,
    businessNumber,
    appSecret,
  })
  .strict();

/**
 * Rotation, of either half, independently.
 *
 * The verify token is always replaced: it is ours to choose and re-running the
 * subscription handshake is the only thing it is for. The app secret is
 * replaced only when the operator has rotated it at the provider — sending it
 * unchanged, or omitting it, both leave the stored one alone.
 */
export const rotateWhatsappChannelSchema = z
  .object({
    appSecret: appSecret.optional(),
  })
  .strict();

export const updateWhatsappChannelSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export type CreateWhatsappChannelInput = z.infer<typeof createWhatsappChannelSchema>;
export type RotateWhatsappChannelInput = z.infer<typeof rotateWhatsappChannelSchema>;
export type UpdateWhatsappChannelInput = z.infer<typeof updateWhatsappChannelSchema>;
