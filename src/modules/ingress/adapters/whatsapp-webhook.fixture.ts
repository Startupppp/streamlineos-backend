import { signPayload } from "./mailbox-push";

/**
 * A real WhatsApp delivery, written down.
 *
 * The whole channel is tested from this and nothing else. No provider SDK is
 * mocked anywhere — there is nothing to mock, because inbound WhatsApp is a
 * signed HTTP body rather than a call we make, and a body is a fixture.
 *
 * The shape is the Cloud API's `entry[].changes[].value` envelope, kept
 * verbatim down to the key names, because that is the contract: a relay in
 * front of it forwards the provider's payload, so the envelope is what any
 * delivery path has in common.
 */

export const FIXTURE_APP_SECRET = "whatsapp-app-secret-for-tests";

/** The business line these deliveries arrive on. */
export const FIXTURE_PHONE_NUMBER_ID = "109876543210987";
export const FIXTURE_BUSINESS_NUMBER = "15550001111";

/** The customer. Bare E.164 digits, which is how `wa_id` is written. */
export const FIXTURE_CUSTOMER_WA_ID = "919876543210";
export const FIXTURE_CUSTOMER_NAME = "Priya Raman";

/** 2025-08-25T08:00:00Z, as unix seconds in a string — the provider's format. */
export const FIXTURE_TIMESTAMP = "1756108800";

export function textMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from: FIXTURE_CUSTOMER_WA_ID,
    id: "wamid.HBgMOTE5ODc2NTQzMjEwFQIAEhgUM0E0RjhCMkQxQzZFOUEwQjdEM0EA",
    timestamp: FIXTURE_TIMESTAMP,
    type: "text",
    text: { body: "Can you resend the quote? The last one had the old address." },
    ...over,
  };
}

/**
 * A document, which is the one media type carrying a name the sender chose.
 *
 * The default name is a traversal attempt on purpose: a filename from WhatsApp
 * is exactly as attacker-controlled as one from email, and the point of the
 * test that reads it is that it goes through the same sanitiser rather than a
 * second one written here.
 */
export function documentMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from: FIXTURE_CUSTOMER_WA_ID,
    id: "wamid.HBgMOTE5ODc2NTQzMjEwFQIAEhgUNEI1RjlDM0UyRDdGMEIxQzhFNEIA",
    timestamp: FIXTURE_TIMESTAMP,
    type: "document",
    document: {
      id: "media-9f2c",
      mime_type: "application/pdf",
      sha256: "8a1f0b6c2d4e5f7a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a",
      filename: "../../etc/passwd",
      caption: "Signed copy, page 3 is the one that changed.",
    },
    ...over,
  };
}

/** An image, which carries no filename at all — only an id and a mime type. */
export function imageMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from: FIXTURE_CUSTOMER_WA_ID,
    id: "wamid.HBgMOTE5ODc2NTQzMjEwFQIAEhgUN0M2RTBBNEYzRThBMUMyRDlGNUMA",
    timestamp: FIXTURE_TIMESTAMP,
    type: "image",
    image: {
      id: "media-4b7e",
      mime_type: "image/jpeg",
      sha256: "1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c",
      caption: "This is the part that arrived cracked.",
    },
    ...over,
  };
}

/** A delivery receipt. Arrives on the same webhook and is not a communication. */
export function statusReceipt(): Record<string, unknown> {
  return {
    id: "wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgSNzhCMEE5RTMxRDRGN0E2QzBBAA",
    status: "read",
    timestamp: FIXTURE_TIMESTAMP,
    recipient_id: FIXTURE_CUSTOMER_WA_ID,
    conversation: { id: "b4e2c0d8f6a1", origin: { type: "service" } },
  };
}

interface DeliveryOptions {
  readonly messages?: readonly Record<string, unknown>[];
  readonly statuses?: readonly Record<string, unknown>[];
  readonly phoneNumberId?: string;
  readonly contacts?: readonly Record<string, unknown>[];
  readonly field?: string;
}

/** One `changes` block, for one business line. */
export function deliveryBlock(options: DeliveryOptions = {}): Record<string, unknown> {
  return {
    field: options.field ?? "messages",
    value: {
      messaging_product: "whatsapp",
      metadata: {
        display_phone_number: FIXTURE_BUSINESS_NUMBER,
        phone_number_id: options.phoneNumberId ?? FIXTURE_PHONE_NUMBER_ID,
      },
      contacts: options.contacts ?? [
        { profile: { name: FIXTURE_CUSTOMER_NAME }, wa_id: FIXTURE_CUSTOMER_WA_ID },
      ],
      ...(options.messages ? { messages: options.messages } : {}),
      ...(options.statuses ? { statuses: options.statuses } : {}),
    },
  };
}

/** A whole webhook body, which may carry blocks for more than one line. */
export function webhookBody(
  blocks: readonly Record<string, unknown>[] = [deliveryBlock({ messages: [textMessage()] })],
): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "102290129340398", changes: blocks }],
  };
}

/**
 * A body and the header that proves it.
 *
 * The raw string is produced once and both signed and parsed from, because the
 * signature covers the bytes as sent — signing one serialisation and verifying
 * another is the mistake that rejects every genuine delivery, so the fixture
 * cannot make it and neither can a test built on it.
 */
export function signedDelivery(
  body: Record<string, unknown> = webhookBody(),
  secret: string = FIXTURE_APP_SECRET,
): { rawBody: string; signature: string; parsed: unknown } {
  const rawBody = JSON.stringify(body);
  const parsed: unknown = JSON.parse(rawBody);
  return { rawBody, signature: `sha256=${signPayload(secret, rawBody)}`, parsed };
}
