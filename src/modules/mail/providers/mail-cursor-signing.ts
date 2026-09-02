import { createHmac } from "node:crypto";

/**
 * HMAC signing shared by both mail cursor namespaces — the provider cursor in
 * `mail-normalizers.ts` and the metadata keyset cursor in
 * `mail-metadata-cursor.ts`.
 *
 * It lives in its own file so the two namespaces stay in their own modules
 * without either importing the other's internals, and so the key derivation has
 * exactly one definition. The key is namespaced off `ENCRYPTION_KEY` so a mail
 * cursor signature can never be replayed against another feature derived from
 * the same secret.
 *
 * A missing `ENCRYPTION_KEY` throws rather than degrading: it is a server
 * misconfiguration, not a client problem, and falling back to page one would
 * hide it. `validateEnv()` requires the key at `main.ts`, so a booted server
 * cannot reach the throw; a test or script calling these directly must set it.
 */
function cursorKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY is not configured — cannot sign mail cursors");
  return createHmac("sha256", raw).update("mail:cursor").digest();
}

export function signCursor(bodyB64: string): string {
  return createHmac("sha256", cursorKey()).update(bodyB64).digest("base64url");
}
