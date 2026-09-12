import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The inbox cursor: a signed, tamper-checked wire value.
 *
 * This is not normalisation. Nothing here knows what a Gmail payload or a Graph
 * message looks like — a cursor is a position in a multi-account feed, and the
 * rules below are about who minted it and whether it has been edited since.
 * That is a different failure mode from "the provider sent a shape we did not
 * expect": a bad cursor is a caller problem answered by returning page one, and
 * a bad payload is a parse error. Keeping them in one file meant the signature
 * check was read through two hundred lines of MIME decoding.
 *
 * `mail-normalizers.ts` re-exports these so its callers are unchanged.
 */

export interface PartialGmailCursor {
  readonly token: string;
  readonly skip: number;
}

/**
 * `null` means this account is exhausted; `undefined` means it has no position
 * yet and should start from the beginning. Collapsing the two loses a whole
 * mailbox: `JSON.stringify` drops an `undefined` value, so an account marked
 * done came back from the wire as absent and the next page re-read it from row
 * zero, re-delivering every message it had already returned.
 */
export type AccountCursorValue = string | number | PartialGmailCursor | null | undefined;

export interface OpaqueCursor {
  [accountId: number]: AccountCursorValue;
}

export function isPartialGmailCursor(v: unknown): v is PartialGmailCursor {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).token === "string" && typeof (v as Record<string, unknown>).skip === "number";
}

/**
 * The inbox cursor is a map of account id to that account's provider position,
 * and it goes to the client. Base64 alone made it editable: a caller could swap
 * one account's page token for another's, or carry a cursor minted for a
 * different user, and the value would reach a provider API unchecked.
 *
 * So it is signed, in the shape `unsubscribe-token.util.ts` already uses — HMAC
 * over the payload with a key namespaced off `ENCRYPTION_KEY`, so a mail cursor
 * signature can never be replayed against another feature derived from the same
 * secret. The reader's id is inside the signed body, which is what makes
 * substitution detectable rather than merely inconvenient.
 *
 * A cursor that is unreadable — wrong shape, bad signature, another reader's,
 * unparseable body — returns `{}`, the first page, which is the rule
 * `common/pagination/cursor.ts` states for every other cursor here. A missing
 * `ENCRYPTION_KEY` is deliberately *not* in that set, and it can no longer be
 * absent here at all: the secret is a required parameter, supplied by
 * `MailService` from the validated config, so a missing key is a boot failure
 * rather than something these functions have to answer for.
 */
const CURSOR_VERSION = "m1";

interface SignedCursorBody {
  readonly u: string;
  readonly c: OpaqueCursor;
}

/**
 * The signing secret is a parameter now, not a `process.env` read.
 *
 * `cursorKey` used to read `ENCRYPTION_KEY` on every encode and every decode,
 * which `no-restricted-syntax` bans, and the old comment above admitted the
 * cost of it in its last sentence: "a test or script that calls these directly
 * must set it". That is the wart — the value was reachable only by mutating the
 * environment, and jest gives every test file its own copy of `process.env`, so
 * setting it in one place proves nothing about another.
 *
 * `MailService` holds it through `APP_CONFIG` and passes it in. `ENCRYPTION_KEY`
 * is required by `env.validation.ts` (min 32), so through that token it is a
 * `string` and the "not configured" throw that could never fire on a booted
 * server is gone with it.
 */
function cursorKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("mail:cursor").digest();
}

function signCursor(bodyB64: string, secret: string): string {
  return createHmac("sha256", cursorKey(secret)).update(bodyB64).digest("base64url");
}

export function encodeCursor(
  cursor: OpaqueCursor,
  userId: string,
  secret: string,
): string {
  const body: SignedCursorBody = { u: userId, c: cursor };
  const encoded = Buffer.from(JSON.stringify(body), "utf-8").toString("base64url");
  return `${CURSOR_VERSION}.${encoded}.${signCursor(encoded, secret)}`;
}

export function decodeCursor(
  encoded: string,
  userId: string,
  secret: string,
): OpaqueCursor {
  const parts = encoded.split(".");
  if (parts.length !== 3) return {};

  const [version, body, signature] = parts;
  if (version !== CURSOR_VERSION || !body || !signature) return {};

  const expected = Buffer.from(signCursor(body, secret), "utf-8");
  const actual = Buffer.from(signature, "utf-8");
  if (expected.length !== actual.length) return {};
  if (!timingSafeEqual(expected, actual)) return {};

  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

    const { u, c } = parsed as Record<string, unknown>;
    if (typeof u !== "string" || u !== userId) return {};
    if (typeof c !== "object" || c === null || Array.isArray(c)) return {};

    return c as OpaqueCursor;
  } catch {
    return {};
  }
}
