import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);
const BLOCKED_SUFFIXES = [".localhost", ".internal", ".local"];

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return true;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255))
    return true;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const value = ip.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (value === "::1" || value === "::") return true;
  if (value.startsWith("fe80")) return true;
  if (/^f[cd]/.test(value)) return true;
  if (value.startsWith("::ffff:")) return isPrivateIpv4(value.slice(7));
  return false;
}

export function isPrivateAddress(host: string): boolean {
  const version = isIP(host);
  if (version === 4) return isPrivateIpv4(host);
  if (version === 6) return isPrivateIpv6(host);
  return false;
}

/** Literal, synchronous check — safe to use inside a Zod refinement. */
export function isPubliclyRoutableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return false;

  const host = url.hostname.toLowerCase();
  if (!host) return false;
  if (BLOCKED_HOSTNAMES.has(host)) return false;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  return !isPrivateAddress(host);
}

/**
 * Resolves the hostname and re-checks it, so a public name that points at a
 * private address (DNS rebinding) is rejected at call time, not just at save time.
 */
export async function resolvesToPublicHost(raw: string): Promise<boolean> {
  if (!isPubliclyRoutableUrl(raw)) return false;
  const host = new URL(raw).hostname.toLowerCase();
  if (isIP(host) !== 0) return true;

  try {
    const records = await lookup(host, { all: true, verbatim: true });
    if (records.length === 0) return false;
    return records.every((record) => !isPrivateAddress(record.address));
  } catch {
    return false;
  }
}
