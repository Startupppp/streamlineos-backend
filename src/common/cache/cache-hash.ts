import { createHash } from "node:crypto";

export function stableHash(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  const normalized: Record<string, unknown> = {};
  for (const k of keys) {
    normalized[k] = value[k];
  }
  return createHash("sha1").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}
