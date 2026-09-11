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

export interface SafeWebhookTarget {
  url: URL;
  addresses: ReadonlyArray<{ address: string; family: 4 | 6 }>;
}

export type WebhookDnsResolver = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export type IpAddressFamily = "ipv4" | "ipv6" | "unknown";
export type IpAddressScope = "public" | "private" | "loopback" | "reserved" | "unknown";

export interface IpAddressFacts {
  family: IpAddressFamily;
  scope: IpAddressScope;
}

/**
 * The one table. Two questions are asked of it.
 *
 * "May we send a request there?" is `scope !== "public"`, which is this
 * module's original job. "What can an auditor be told about the address a
 * signature came from?" is the scope itself — e-sign's signer annotation,
 * which used to carry a second copy of these ranges. Two copies of a blocklist
 * is the defect `injection-surfaces` exists to catch, and they had already
 * drifted: this side blocked the documentation ranges the other called public,
 * and the other named the RFC 2544 benchmark range this one allowed. The union
 * is what a single table has to be — a range either side called non-public
 * stays non-public, so nothing that was blocked becomes reachable.
 */
function classifyIpv4(address: string): IpAddressScope {
  const parts = address.split(".").map(Number);
  const [a, b, c] = parts;
  if (a === undefined || b === undefined) return "unknown";
  if (parts.length !== 4 || parts.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255))
    return "unknown";
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  /** Carrier-grade NAT: not the public internet, and common behind mobile networks. */
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a === 0) return "reserved";
  /** Link-local, which is where a cloud metadata service answers. */
  if (a === 169 && b === 254) return "reserved";
  if (a === 192 && b === 0) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "reserved";
  if (a === 203 && b === 0 && c === 113) return "reserved";
  /** RFC 2544 benchmarking. */
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a >= 224) return "reserved";
  return "public";
}

function classifyIpv6(address: string): IpAddressScope {
  const value = address.toLowerCase().split("%")[0] ?? "";
  if (value === "::" || value === "::1") return "loopback";
  if (/^fe[89ab][0-9a-f]/.test(value)) return "reserved";
  if (value.startsWith("fc") || value.startsWith("fd")) return "private";
  if (value.startsWith("ff")) return "reserved";
  return "public";
}

/**
 * What can be said about an address without asking anybody: its family, and
 * whether it is on the public internet at all. An IPv4-mapped IPv6 address is
 * reported as the IPv4 it is, because a signer on a dual-stack socket has
 * never used an address family they cannot see.
 */
export function classifyIpAddress(address: string | null | undefined): IpAddressFacts {
  if (address === null || address === undefined || address.trim() === "")
    return { family: "unknown", scope: "unknown" };
  const value = address.trim();
  const family = isIP(value);
  if (family === 4) return { family: "ipv4", scope: classifyIpv4(value) };
  if (family === 6) {
    const mapped = mappedIpv4(value.toLowerCase().split("%")[0] ?? "");
    if (mapped !== null) return { family: "ipv4", scope: classifyIpv4(mapped) };
    return { family: "ipv6", scope: classifyIpv6(value) };
  }
  const bare = value.replace(/^::ffff:/i, "");
  if (isIP(bare) === 4) return { family: "ipv4", scope: classifyIpv4(bare) };
  return { family: "unknown", scope: "unknown" };
}

function isBlockedIpv4(address: string): boolean {
  return classifyIpv4(address) !== "public";
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
  const mapped = mappedIpv4(value);
  if (mapped !== null) return isBlockedIpv4(mapped);
  return classifyIpv6(value) !== "public";
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

/**
 * Rejects outbound targets that point at loopback, private, link-local,
 * carrier-grade-NAT, or multicast space — including the cloud metadata endpoint
 * at 169.254.169.254 (OWASP API Top 10 A07).
 *
 * Resolves the hostname because an attacker-controlled DNS name can map to an
 * internal address. Callers must also disable redirect following, since a
 * permitted host can 302 to an internal one.
 */
export async function resolveSafeWebhookTarget(
  rawUrl: string,
  resolve: WebhookDnsResolver = (hostname) => lookup(hostname, { all: true }),
): Promise<SafeWebhookTarget | { reason: WebhookUrlRejection }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { reason: "invalid-url" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { reason: "unsupported-scheme" };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  if (isIP(hostname) !== 0) {
    if (isBlockedAddress(hostname)) return { reason: "blocked-address" };
    return {
      url: parsed,
      addresses: [{ address: hostname, family: isIP(hostname) as 4 | 6 }],
    };
  }

  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = [...await resolve(hostname)];
  } catch {
    return { reason: "unresolvable-host" };
  }

  if (resolved.length === 0) return { reason: "unresolvable-host" };
  if (resolved.some((entry) => isBlockedAddress(entry.address))) {
    return { reason: "blocked-address" };
  }

  return {
    url: parsed,
    addresses: resolved.map(({ address, family }) => ({
      address,
      family: family === 6 ? 6 : 4,
    })),
  };
}

export async function checkWebhookUrl(rawUrl: string): Promise<WebhookUrlCheck> {
  const target = await resolveSafeWebhookTarget(rawUrl);
  return "reason" in target
    ? { allowed: false, reason: target.reason }
    : { allowed: true };
}

/**
 * Synchronous best-effort guard for callers that cannot await DNS resolution.
 *
 * Weaker than `checkWebhookUrl` by construction: a hostname that resolves to an
 * internal address still passes, because no lookup happens. Prefer
 * `checkWebhookUrl` in any new code.
 */
export function assertSafeWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("SSRF: only http(s) URLs are allowed");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const lowered = hostname.toLowerCase();
  if (hostname === "" || lowered === "localhost" || lowered.endsWith(".localhost")) {
    throw new Error("SSRF: private/internal URLs are blocked");
  }

  if (isIP(hostname) !== 0 && isBlockedAddress(hostname)) {
    throw new Error("SSRF: private/internal URLs are blocked");
  }
}
