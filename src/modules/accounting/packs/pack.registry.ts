import { Injectable, Optional } from "@nestjs/common";
import { ALL_PACKS, GENERIC_VAT_PACK } from "./pack.definitions";
import { PackNotFoundError, type LocalizationPack } from "./pack.types";

/**
 * The one place a pack is looked up. Nothing outside this file may branch on a
 * country code — that is the difference between a pluggable localization and
 * `if (country === 'IN')` sprayed through AR (A6).
 */
@Injectable()
export class PackRegistry {
  private readonly byCode = new Map<string, LocalizationPack>();
  private readonly byCountry = new Map<string, LocalizationPack>();

  /**
   * `@Optional()` because Nest cannot resolve a bare array type. Production
   * gets the default registry; tests pass their own list positionally.
   */
  constructor(@Optional() packs: readonly LocalizationPack[] = ALL_PACKS) {
    for (const pack of packs) {
      this.byCode.set(pack.code, pack);
      for (const country of pack.countryCodes) {
        // First registration wins, so a real pack always beats a stub that
        // happens to list the same country.
        if (!this.byCountry.has(country)) this.byCountry.set(country, pack);
      }
    }
  }

  list(): readonly LocalizationPack[] {
    return [...this.byCode.values()];
  }

  has(code: string): boolean {
    return this.byCode.has(code);
  }

  /** Throws rather than returning undefined — a missing pack is never benign. */
  get(code: string): LocalizationPack {
    const pack = this.byCode.get(code);
    if (!pack) throw new PackNotFoundError(code);
    return pack;
  }

  /**
   * Best pack for a country at enable time. Falls back to generic VAT so a
   * founder in a country nobody has written a pack for can still keep books.
   */
  forCountry(countryCode: string): LocalizationPack {
    return this.byCountry.get(countryCode.toUpperCase()) ?? GENERIC_VAT_PACK;
  }
}
