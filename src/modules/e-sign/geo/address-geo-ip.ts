import { Injectable } from "@nestjs/common";
import { classifyIpAddress } from "../../../common/security/ssrf-guard";
import type { SignGeoIpPort, SignGeoLocation } from "./geo-ip.port";

/**
 * The resolver that ships: everything derivable from the address itself, and
 * an explicit statement that no location lookup happened.
 *
 * Writing `{ country: null }` with no explanation would be worse than the
 * empty column it replaces — a reader cannot tell whether the lookup failed,
 * was never attempted, or genuinely found nothing. This records `source`,
 * `confidence: "none"` and a note, so the row says exactly how much it knows.
 */
@Injectable()
export class AddressGeoIp implements SignGeoIpPort {
  async locate(ip: string | null | undefined): Promise<SignGeoLocation | null> {
    try {
      const facts = classifyIpAddress(ip);
      return {
        ip: ip ?? null,
        family: facts.family,
        scope: facts.scope,
        country: null,
        region: null,
        city: null,
        source: "address-classification",
        confidence: "none",
        resolvedAt: new Date().toISOString(),
        note:
          "No geo-IP provider is configured; only facts derivable from the address " +
          "itself are recorded. Country, region and city were not looked up.",
      };
    } catch {
      /** Never the reason a signature goes unrecorded. */
      return null;
    }
  }
}
