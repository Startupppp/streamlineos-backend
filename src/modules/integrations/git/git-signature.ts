import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyGithubSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null | undefined,
): boolean {
  if (!secret || !signatureHeader) return false;
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const provided = signatureHeader.slice(prefix.length);
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export function verifyGitlabToken(
  secret: string,
  tokenHeader: string | null | undefined,
): boolean {
  if (!secret || !tokenHeader) return false;
  const a = Buffer.from(secret, "utf8");
  const b = Buffer.from(tokenHeader, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
