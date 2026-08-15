import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless, signed unsubscribe tokens.
 *
 * Deliberately NOT a stored id: a guessable identifier in an unsubscribe link
 * lets anyone opt out arbitrary contacts. HMAC over the payload means a token
 * cannot be forged or enumerated without the server key, so no token table,
 * no expiry sweep, and no extra round-trip on send.
 *
 * The trade-off is that individual tokens cannot be revoked — acceptable here
 * because the only action they authorise is *withdrawing* consent, which is
 * idempotent, self-harming at worst, and reversible by the org.
 */
const VERSION = "u1";

export interface UnsubscribePayload {
  orgId: string;
  contactId: number;
  channel: "EMAIL" | "SMS" | "WHATSAPP" | "PHONE" | "POST";
}

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY is not configured — cannot sign unsubscribe links");
  // Namespaced so an unsubscribe signature can never be replayed against
  // another feature that derives a key from the same secret.
  return createHmac("sha256", raw).update("crm:unsubscribe").digest();
}

function sign(payloadB64: string): string {
  return createHmac("sha256", key()).update(payloadB64).digest("base64url");
}

export function buildUnsubscribeToken(payload: UnsubscribePayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${VERSION}.${body}.${sign(body)}`;
}

export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [version, body, signature] = parts;
  if (version !== VERSION || !body || !signature) return null;

  const expected = Buffer.from(sign(body), "utf8");
  const actual = Buffer.from(signature, "utf8");
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;

    const { orgId, contactId, channel } = parsed as Record<string, unknown>;
    if (typeof orgId !== "string" || orgId.length === 0) return null;
    if (typeof contactId !== "number" || !Number.isInteger(contactId) || contactId <= 0) return null;
    if (
      channel !== "EMAIL" &&
      channel !== "SMS" &&
      channel !== "WHATSAPP" &&
      channel !== "PHONE" &&
      channel !== "POST"
    )
      return null;

    return { orgId, contactId, channel };
  } catch {
    return null;
  }
}
