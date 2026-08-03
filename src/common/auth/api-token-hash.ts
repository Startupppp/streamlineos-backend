import { createHash, randomBytes } from "node:crypto";

export const PAT_TOKEN_PREFIX = "sos_pat_";

const DISPLAY_PREFIX_LENGTH = PAT_TOKEN_PREFIX.length + 8;

const LEGACY_PREFIX_LENGTH = 8;

export function hashApiToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function generateApiToken(): string {
  return `${PAT_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

export function apiTokenDisplayPrefix(rawToken: string): string {
  return rawToken.slice(0, DISPLAY_PREFIX_LENGTH);
}

export function legacyApiTokenPrefix(rawToken: string): string {
  return rawToken.slice(0, LEGACY_PREFIX_LENGTH);
}

export function isModernApiToken(rawToken: string): boolean {
  return rawToken.startsWith(PAT_TOKEN_PREFIX);
}
