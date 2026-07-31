import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type WebhookUrlRejection =
  | "invalid-url"
  | "unsupported-scheme"
  | "unresolvable-host"
  | "blocked-address";

export type WebhookUrlCheck =
  | { allowed: true }
  | { allowed: false; reason: WebhookUrlRejection };

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [a, b] = parts;
  if (a === undefined || b === undefined) return true;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a >= 224) return true;
  return false;
}

/**
 * `new URL()` normalises an IPv4-mapped address, so `::ffff:127.0.0.1` arrives
 * as `::ffff:7f00:1`. Both spellings must resolve to the same IPv4 check.
 */
function mappedIpv4(value: string): string | null {
  if (!value.startsWith("::ffff:")) return null;
  const tail = value.slice(7);
  if (isIP(tail) === 4) return tail;
  const hextets = tail.split(":");
  if (hextets.length !== 2) return null;
  const [high, low] = hextets;
  if (high === undefined || low === undefined) return null;
  if (!/^[0-9a-f]{1,4}$/.test(high) || !/^[0-9a-f]{1,4}$/.test(low)) return null;
  const packed = (parseInt(high, 16) << 16) | parseInt(low, 16);
  return [
    (packed >>> 24) & 0xff,
    (packed >>> 16) & 0xff,
    (packed >>> 8) & 0xff,
    packed & 0xff,
  ].join(".");
}

function isBlockedIpv6(address: string): boolean {
  const value = address.toLowerCase().split("%")[0] ?? "";
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fe80")) return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (value.startsWith("ff")) return true;
  const mapped = mappedIpv4(value);
  if (mapped !== null) return isBlockedIpv4(mapped);
  return false;
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

/**
 * Rejects outbound webhook targets that point at loopback, private, link-local,
 * carrier-grade-NAT, or multicast space — including the cloud metadata endpoint
 * at 169.254.169.254 (OWASP API Top 10 A07).
 *
 * Resolves the hostname because an attacker-controlled DNS name can map to an
 * internal address. Callers must also disable redirect following, since a
 * permitted host can 302 to an internal one.
 */
export async function checkWebhookUrl(rawUrl: string): Promise<WebhookUrlCheck> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "invalid-url" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { allowed: false, reason: "unsupported-scheme" };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  if (isIP(hostname) !== 0) {
    return isBlockedAddress(hostname)
      ? { allowed: false, reason: "blocked-address" }
      : { allowed: true };
  }

  let resolved: { address: string }[];
  try {
    resolved = await lookup(hostname, { all: true });
  } catch {
    return { allowed: false, reason: "unresolvable-host" };
  }

  if (resolved.length === 0) return { allowed: false, reason: "unresolvable-host" };
  if (resolved.some((entry) => isBlockedAddress(entry.address))) {
    return { allowed: false, reason: "blocked-address" };
  }

  return { allowed: true };
}
