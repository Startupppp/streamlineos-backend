import { createHmac, timingSafeEqual, randomUUID } from "crypto";

export type UnsubscribeScope = "TYPE" | "CATEGORY" | "ALL_NON_MANDATORY";

export interface UnsubscribePayload {
  userId: string;
  orgId: string;
  email: string;
  scope: UnsubscribeScope;
  /** Event key or category name; empty for ALL_NON_MANDATORY. */
  scopeKey: string;
  expiresAt: number;
  nonce: string;
}

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

function secret(): string | null {
  const value = process.env.UNSUBSCRIBE_TOKEN_SECRET?.trim();
  return value && value.length >= 32 ? value : null;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(body: string, key: string): string {
  return createHmac("sha256", key).update(body).digest("base64url");
}

/**
 * COMP-002. A signed, expiring, single-purpose, single-user unsubscribe token.
 *
 * Keyed on a dedicated `UNSUBSCRIBE_TOKEN_SECRET`, never the session JWT secret — a
 * leaked unsubscribe link must not be replayable against anything else, and this one
 * travels in plain-text email and sits in mail archives forever.
 *
 * The payload names the subject explicitly, so a token cannot be pointed at another
 * user by editing it: any change invalidates the signature.
 */
export function createUnsubscribeToken(
  input: Omit<UnsubscribePayload, "expiresAt" | "nonce">,
  now = Date.now(),
): string | null {
  const key = secret();
  if (!key) return null;
  const payload: UnsubscribePayload = { ...input, expiresAt: now + TTL_MS, nonce: randomUUID() };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body, key)}`;
}

/** Returns null for anything not currently valid — bad signature, tampering, expiry. */
export function verifyUnsubscribeToken(
  token: string,
  now = Date.now(),
): UnsubscribePayload | null {
  const key = secret();
  if (!key) return null;

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  const expected = sign(body, key);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (
      typeof p.userId !== "string" ||
      typeof p.orgId !== "string" ||
      typeof p.email !== "string" ||
      typeof p.scopeKey !== "string" ||
      typeof p.expiresAt !== "number" ||
      typeof p.nonce !== "string" ||
      (p.scope !== "TYPE" && p.scope !== "CATEGORY" && p.scope !== "ALL_NON_MANDATORY")
    )
      return null;
    if (p.expiresAt <= now) return null;
    return {
      userId: p.userId,
      orgId: p.orgId,
      email: p.email,
      scope: p.scope,
      scopeKey: p.scopeKey,
      expiresAt: p.expiresAt,
      nonce: p.nonce,
    };
  } catch {
    return null;
  }
}
