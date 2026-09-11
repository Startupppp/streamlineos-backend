/**
 * What can be said about a signer's IP address without asking anybody.
 *
 * `sign_audit_events.geolocation_json` has existed since SignOS shipped and
 * nothing has ever written to it. The obvious fix — call a geo-IP service — is
 * not available here: no provider is configured, and adding one is a
 * dependency and a privacy decision rather than a stub fix.
 *
 * But "we could not resolve a country" is not the same as "we know nothing".
 * The address itself carries facts that matter to an auditor and cost no
 * network call: whether it is IPv4 or IPv6, and whether it is a public address
 * at all. A signature recorded from `127.0.0.1` or `10.x` means the request
 * reached the application without a forwarded client address — the audit trail
 * says "signed from the server", which is a finding in itself and one that a
 * null column hides completely.
 */

export type AddressFamily = "ipv4" | "ipv6" | "unknown";
export type AddressScope = "public" | "private" | "loopback" | "reserved" | "unknown";

export interface AddressFacts {
  family: AddressFamily;
  scope: AddressScope;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function classifyIpv4(octets: number[]): AddressScope {
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  /** Carrier-grade NAT: not the public internet, and common behind mobile networks. */
  if (a === 100 && b >= 64 && b <= 127) return "private";
  /** Link-local, multicast, broadcast, and the RFC 2544 benchmark range. */
  if (a === 169 && b === 254) return "reserved";
  if (a === 0 || a >= 224) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  return "public";
}

export function classifyAddress(ip: string | null | undefined): AddressFacts {
  if (!ip) return { family: "unknown", scope: "unknown" };

  /**
   * `::ffff:203.0.113.5` is how an IPv4 client arrives on a dual-stack socket.
   * Treating it as IPv6 would classify a perfectly ordinary signer as an
   * address family their device has never used.
   */
  const trimmed = ip.trim().replace(/^::ffff:/i, "");

  const v4 = IPV4.exec(trimmed);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return { family: "unknown", scope: "unknown" };
    return { family: "ipv4", scope: classifyIpv4(octets) };
  }

  if (trimmed.includes(":")) {
    const lower = trimmed.toLowerCase();
    if (lower === "::1") return { family: "ipv6", scope: "loopback" };
    /** Unique local addresses, fc00::/7. */
    if (/^f[cd]/.test(lower)) return { family: "ipv6", scope: "private" };
    if (/^fe[89ab]/.test(lower)) return { family: "ipv6", scope: "reserved" };
    return { family: "ipv6", scope: "public" };
  }

  return { family: "unknown", scope: "unknown" };
}
