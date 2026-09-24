import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The one HMAC check every inbound vendor callback uses.
 *
 * Extracted from the job-board ingress rather than copied: background checks,
 * assessment scores and voice-screen results all arrive the same way, and a
 * second implementation of a signature check is a second chance to get the
 * constant-time comparison wrong.
 *
 * It verifies the exact bytes the vendor sent. Re-serialising a parsed body and
 * signing that would verify something the vendor never wrote, which is why
 * every caller reads `req.rawBody` and parses only after this returns true.
 *
 * The length check before `timingSafeEqual` is not an optimisation — that
 * function throws on mismatched lengths, and a throw here would turn a
 * malformed signature into a 500 on a public endpoint.
 */
export function verifyVendorSignature(
  rawBody: Buffer | string,
  secret: string,
  providedSignature: string | undefined,
): boolean {
  if (!providedSignature) return false;
  const provided = providedSignature.replace(/^sha256=/i, "").trim();
  if (!/^[0-9a-f]+$/i.test(provided)) return false;
  const expected = createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody)
    .digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
