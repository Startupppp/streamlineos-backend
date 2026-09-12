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

import type { IpAddressFamily, IpAddressScope } from "../../../common/security/ssrf-guard";
import { classifyIpAddress } from "../../../common/security/ssrf-guard";

export type AddressFamily = IpAddressFamily;
export type AddressScope = IpAddressScope;

export interface AddressFacts {
  family: AddressFamily;
  scope: AddressScope;
}

/**
 * Delegated, not duplicated.
 *
 * These ranges used to be written out again here, which is a second copy of
 * the outbound blocklist — the thing `injection-surfaces` refuses, and for a
 * good reason: the two copies had already drifted apart in both directions.
 * The shared guard now answers the classification question as well as the
 * "may we call it" one, so a range is named in exactly one place.
 */
export function classifyAddress(ip: string | null | undefined): AddressFacts {
  return classifyIpAddress(ip);
}
