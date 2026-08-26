/**
 * Which region a new organisation is placed in, from where it says it is.
 *
 * Placement is a promise about where data rests, so it is decided once, at
 * creation, from something the customer told us -- not inferred later from an IP
 * address or a browser locale, which change with a business trip.
 *
 * A country we do not map falls to the default rather than failing: refusing to
 * create an organisation because its country is unmapped would turn a signup
 * into a support ticket, and the default is a region we actually operate. The
 * customer is told which one before they commit.
 */

/**
 * Countries whose data we place in the EU region.
 *
 * Deliberately its own list rather than the tax module's EU set, even though the
 * two coincide today. They answer different questions and will diverge: data
 * residency follows the EEA and adequacy decisions, tax treatment follows VAT
 * membership, and Norway is in one and not the other. Sharing a list would make
 * a VAT change silently move where somebody's data lives.
 *
 * Also: `common/` must not import from `modules/`. A residency rule that depends
 * on the billing module is a residency rule that cannot be reasoned about
 * without reading billing.
 */
const EU_RESIDENCY: ReadonlySet<string> = new Set([
  "IE", "DE", "FR", "NL", "ES", "IT", "BE", "AT", "PT", "SE", "DK", "FI", "PL", "NO", "IS", "LI",
]);

/** Regions this deployment may place into, in the order preference falls back. */
export const PLACEMENT_REGIONS = ["eu", "us", "india"] as const;
export type PlacementRegion = (typeof PLACEMENT_REGIONS)[number];

/**
 * Countries whose customers we place outside the default.
 *
 * Deliberately explicit rather than a continent lookup: placement is a
 * commitment we make in writing, and "somewhere in Asia" is not one.
 */
const NORTH_AMERICA: ReadonlySet<string> = new Set(["US", "CA", "MX"]);

const SOUTH_ASIA: ReadonlySet<string> = new Set(["IN", "LK", "BD", "NP", "BT"]);

/**
 * The default when a country maps to nothing.
 *
 * India, because that is where the platform is established and where the
 * majority of tenants are; a customer placed here is placed somewhere we
 * actually operate rather than somewhere aspirational.
 */
export const DEFAULT_PLACEMENT: PlacementRegion = "india";

export interface Placement {
  readonly region: PlacementRegion;
  /** Whether the country was mapped, or fell to the default. */
  readonly isMapped: boolean;
  /** What to tell the customer before they commit. */
  readonly description: string;
}

const DESCRIPTIONS: Readonly<Record<PlacementRegion, string>> = {
  eu: "European Union (Ireland)",
  us: "United States",
  india: "India",
};

export function regionForCountry(country: string | null | undefined): Placement {
  const code = (country ?? "").trim().toUpperCase();

  if (EU_RESIDENCY.has(code))
    return { region: "eu", isMapped: true, description: DESCRIPTIONS.eu };

  if (NORTH_AMERICA.has(code))
    return { region: "us", isMapped: true, description: DESCRIPTIONS.us };

  if (SOUTH_ASIA.has(code))
    return { region: "india", isMapped: true, description: DESCRIPTIONS.india };

  return {
    region: DEFAULT_PLACEMENT,
    isMapped: false,
    description: DESCRIPTIONS[DEFAULT_PLACEMENT],
  };
}

/**
 * Whether a placement can be honoured by this deployment.
 *
 * A country mapping to a region nobody has configured would place a tenant
 * somewhere unreachable, which fails at the first query rather than at signup --
 * the wrong end.
 */
export function isPlaceable(
  placement: Placement,
  configuredRegions: readonly string[],
): boolean {
  return configuredRegions.includes(placement.region);
}
