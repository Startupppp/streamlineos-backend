import { createHash, randomBytes } from "node:crypto";

const PUBLIC_TOKEN_BYTES = 24;

export function newPublicToken(): string {
  return randomBytes(PUBLIC_TOKEN_BYTES).toString("hex");
}

export function hashPublicToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
