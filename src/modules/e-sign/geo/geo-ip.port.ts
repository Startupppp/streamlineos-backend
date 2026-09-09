import type { AddressFamily, AddressScope } from "./address-classifier";

/**
 * What gets written into `sign_audit_events.geolocation_json`.
 *
 * `source` and `confidence` are not decoration. This record ends up in a
 * certificate of completion that somebody may rely on, and "India" derived
 * from a geo-IP database is a materially weaker claim than "India" from a
 * signed government identity. Recording where the answer came from is what
 * lets a reader weigh it — and, when no provider is configured, what stops the
 * absence of a country being mistaken for the absence of a signer.
 */
export interface SignGeoLocation {
  ip: string | null;
  family: AddressFamily;
  scope: AddressScope;
  country: string | null;
  region: string | null;
  city: string | null;
  /** Which mechanism produced this. `address-classification` used no network. */
  source: string;
  confidence: "none" | "low" | "medium" | "high";
  resolvedAt: string;
  /** Why the location fields are empty, when they are. */
  note?: string;
}

export interface SignGeoIpPort {
  /**
   * Best effort, and never throwing is part of the contract. This runs on the
   * path that records a signature; a geo lookup failing must never be the
   * reason a signature is not recorded.
   */
  locate(ip: string | null | undefined): Promise<SignGeoLocation | null>;
}

export const SIGN_GEO_IP = Symbol("SignGeoIpPort");
